/**
 * BadgeCore 实时转写器：设备 OPUS 帧 → PCM → 讯飞听写（多会话接力）
 * ----------------------------------------------------------------
 * - opusscript 解码 OPUS 包（libopus 1.4 wasm，与 PyAV 官方实现交叉验证一致，见 HARDWARE-LOG）
 * - 讯飞单会话上限 60s：每累计 55s 音频自动换段（finish 当前 → 开新段），换段间隙的音频缓存在内存，不丢失
 * - 会话错误（网络抖动/超时）自动重开新会话续推，不中断整段转写
 * - end(cb)：输入结束后回调完整全文；wpgs 修正文本以「段」为粒度累计
 *
 * 用法见 receiver.js 集成；凭据来自 xfyun-iat.loadConfig
 */
const OpusScript = require('opusscript');
const { openIatSession } = require('./xfyun-iat');

const SESSION_MAX_BYTES = 55 * 32000; // 55s @16k s16le mono（单会话上限 60s 留余量）
const RETRY_MS = 1000;

/**
 * @param cfg xfyun-iat.loadConfig() 的返回值
 * @param opts.onText(fullText)   累计全文有增量时触发（增量 ≥2 字才触发，避免刷屏）
 * @param opts.onNotice(msg)      运行状态/异常提示（不致命）
 */
function createLiveTranscriber(cfg, { onText, onNotice } = {}) {
  const decoder = new OpusScript(16000, 1, OpusScript.Application.VOIP);
  let session = null;
  let started = false;
  let rolling = false; // 正在换段（等当前会话 onFinal 后开新段）
  let sessionBytes = 0;
  let pending = Buffer.alloc(0); // 无会话期间缓存的 PCM
  let fullText = '';
  let lastShownLen = 0;
  let ended = false;
  let endedCb = null;
  let destroyed = false;
  let failStreak = 0; // 连续失败计数（onFinal 清零），≥3 次停用转写（录音不受影响）
  let dead = false; // 转写已停用（录音不受影响）

  function emitCombined(sessionText) {
    if (!onText) return;
    const combined = fullText + sessionText;
    if (combined.length - lastShownLen >= 2) { // 增量 ≥2 字才触发，避免刷屏
      lastShownLen = combined.length;
      onText(combined);
    }
  }
  function fireEnded() {
    if (destroyed) return;
    destroyed = true;
    decoder.delete();
    if (endedCb) {
      const cb = endedCb;
      endedCb = null;
      cb(fullText);
    }
  }

  function startSession() {
    sessionBytes = 0;
    rolling = false;
    session = openIatSession(cfg, {
      onText: t => emitCombined(t),
      onFinal: t => {
        fullText += t;
        failStreak = 0;
        emitCombined(''); // 冲刷本段最终文本
        session = null;
        if (rolling) {
          startSession(); // 换段：新会话（startSession 内部会 drain pending）
        } else if (ended) {
          fireEnded();
        }
      },
      onError: e => {
        session = null;
        if (!ended && !destroyed && ++failStreak >= 3) {
          if (onNotice) onNotice(`连续 3 次会话失败，本连接实时转写停用（录音不受影响）: ${e.message}`);
          dead = true;
          return;
        }
        if (onNotice) onNotice(`听写会话中断，${RETRY_MS / 1000}s 后重连: ${e.message}`);
        if (!ended && !destroyed) {
          setTimeout(() => {
            if (!ended && !destroyed && !session) startSession();
          }, RETRY_MS);
        } else {
          fireEnded(); // 结束阶段出错：交付已得文本
        }
      },
    });
    if (pending.length && session) {
      session.pushPcm(pending);
      sessionBytes += pending.length;
      pending = Buffer.alloc(0);
    }
    if (ended) session.finish(); // 刚开就要求结束（换段途中 end() 的边界）
  }

  return {
    /** 喂入一个设备 OPUS packet（已剥传输帧头） */
    pushOpus(packet) {
      if (ended || destroyed || dead) return;
      let pcm;
      try {
        pcm = decoder.decode(packet);
      } catch (e) {
        if (onNotice) onNotice(`OPUS 解码失败，跳过该帧: ${e.message}`);
        return;
      }
      if (session && !rolling) {
        session.pushPcm(pcm);
        sessionBytes += pcm.length;
        if (sessionBytes >= SESSION_MAX_BYTES) {
          // 触发换段：结束当前会话；onFinal 里开新段
          rolling = true;
          const s = session;
          session = null; // 后续音频进 pending
          s.finish();
        }
      } else {
        pending = Buffer.concat([pending, pcm]);
        if (!started) {
          started = true;
          startSession();
        }
      }
    },

    /** 输入结束（设备断开）；cb(全文本) */
    end(cb) {
      if (destroyed) { cb(fullText); return; }
      ended = true;
      endedCb = cb;
      if (session && !rolling) {
        session.finish();
      } else if (!rolling && !session) {
        fireEnded(); // 从未开启会话（无音频）或会话已自然结束
      }
      // rolling 中：等 onFinal → startSession → 立即 finish → onFinal → fireEnded
    },

    /** 强制丢弃（不回调） */
    abort() {
      if (destroyed) return;
      destroyed = true;
      ended = true;
      endedCb = null;
      if (session) session.abort();
      decoder.delete();
    },
  };
}

module.exports = { createLiveTranscriber };
