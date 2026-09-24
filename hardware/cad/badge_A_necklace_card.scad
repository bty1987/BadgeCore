// =====================================================================
// BadgeCore 形态A · 挂脖卡片工牌外壳（参数化 3D 打印设计稿 v5）
// v5（09-20 拍板 D21）：工牌基本不搞屏幕——面板=贴纸身份凹槽 + 低耗 LED 状态灯
//   （导光柱），为持久运行；板载 SSD1306 默认不开窗（调试可开 win_on）。
// v4（09-20，参照市场样机图）：挂绳样式加「顶部工牌横槽」选项，面板加预留按键孔。
// v2.1：叠层对齐（壁1.4/背板1.2/面板1.2/间隙0.4/元件区3.4）→ 57.4×88.4×12.4。
// v2（D20）：去除喇叭；电池 403450(800mAh)，回退 503035 改 50/30/5。
// 设计基准：立创开源 S3V19 超薄卡片版
//   ESP32-S3-N16R8 + INMP441 + MAX98357 + SSD1306 128x32 + MCP73831
// 板子到货后（预计 2026-09-25）先游标卡尺实测，再改 [PCB] 与开孔段参数，
// 重新导出 STL。默认尺寸为占位假设，见设计稿文档的《到货实测清单》。
//
// 使用：OpenSCAD 打开本文件 → 按需改参数 → 左上 part 变量选 shell / face
//   → F6 渲染 → File > Export > STL。
// 结构：主壳(背) + 面板(正) 两件式，4x M2x6 自攻螺丝（与原工程一致）。
// =====================================================================

part = "all";   // [all, shell, face]  all=爆炸预览  shell=主壳(背)  face=面板(正)

/* [PCB · 到货实测后修改] */
pcb_l   = 85.0;  // PCB 长边 Y（卡片基准 85，实测后改）
pcb_w   = 54.0;  // PCB 短边 X
pcb_t   = 1.6;   // PCB 厚
hole_in = 4.0;   // 安装孔中心到板边距离（四角对称）

/* [壳体]（与形态B 对齐的叠层取值） */
wall     = 1.4;  // 侧壁厚
floor_t  = 1.2;  // 主壳背板厚
face_t   = 1.2;  // 面板皮厚
clr      = 0.3;  // PCB 单边间隙
corner_r = 7.0;  // 外壳圆角
lip_d    = 3.4;  // 面板裙边插入深度（A 特意比 B 深：挂绳拉力经由面板传递）

/* [电池] 默认 403450 锂聚合物 800mAh，横放（长边沿 X） */
bat_l   = 50;    // X 向
bat_w   = 34;    // Y 向
bat_h   = 4.0;
bat_cy  = 0;     // 电池中心 Y（+ = 靠屏幕端）
bay_extra = 0.6; // 电池上下各留间隙
pcb_gap   = 0.4; // PCB 与电池面间隙

/* [侧壁开口] */
sw_x    = 6;      // 拨动开关中心 X（顶边）
usb_w   = 10.2;   // USB-C 过孔宽（孔顶到主壳顶面，高自动取 4.1）
usb_zin = 0.3;    // 孔顶低于 PCB 顶面的距离

/* [面板构成] 贴纸身份区 + LED 状态灯（D21：基本不搞屏幕，身份=印刷贴纸） */
label_on = true;
label_w  = 30; label_h = 18; label_cx = 0; label_cy = 22; label_d = 0.4; // 贴纸凹槽（姓名/工号/公司）
win_on   = false;  // 板载 SSD1306 视窗：默认不开（调试时开，注意与贴纸区避让）
win_w    = 25.2; win_h = 9.4; win_cy = 24;
mic_x    = -14;  mic_y = 38;               // INMP441 后腔位（背出声）
mic_d    = 2.0;
led_on   = true; led_x = 0; led_y = 36; led_d = 3.0; // 低耗 LED 状态灯（导光柱直通面板）

/* [挂绳样式] */
eye_style  = "rings";   // [rings, slot]  rings=双角圆孔(挂绳直穿)  slot=顶部工牌横槽(配标准工牌夹)
eye_x      = 19;    // rings：两孔中心距中线
eye_d      = 4.5;   // rings：孔径
eye_ring_d = 13;    // rings：环台直径
slot_l     = 13.5;  // slot：横槽长
slot_w     = 4.5;   // slot：横槽宽（配工牌夹挂钩）
slot_cy_off = 12;   // slot：槽中心距顶边

/* [预留按键孔] 录音/SOS，板子实测后启用（改 btn_on=true 并校坐标） */
btn_on = false;
btn_positions = [[-14, -30], [14, -30]]; // 面板坐标 [x,y]
btn_d = 5.0; btn_cb_d = 9.0; btn_cb_h = 0.6;

/* [装配/其他] */
boss_d  = 5.0; pilot_d = 1.7;  // M2 自攻，配 M2x6
logo    = true;
logo_txt = "BadgeCore";
part_gap = 8;    // all 视图两件间距
comp_h   = 3.4;  // PCB 顶面最高元件预留（原工程 8mm 整机反推约 2.5~3.5）
$fn = 48;

/* ---- 派生尺寸（勿手改） ---- */
inn_w = pcb_w + 2*clr;   inn_l = pcb_l + 2*clr;
out_w = inn_w + 2*wall;  out_l = inn_l + 2*wall;
in_r  = corner_r - wall;
bay_h   = bat_h + bay_extra;
pcb_z   = floor_t + bay_h + pcb_gap;           // PCB 底面高度
shell_h = pcb_z + pcb_t + comp_h;              // 主壳总高
hole_dx = pcb_w/2 - hole_in;  hole_dy = pcb_l/2 - hole_in;
eye_cy  = out_l/2 - eye_ring_d/2;
slot_cy = out_l/2 - slot_cy_off;
usb_z0  = pcb_z + pcb_t - usb_zin;             // USB 孔下沿（孔顶到主壳顶面）

// ---------- 2D 轮廓 ----------
module outer2d() { // rings=圆角矩形∪双环台；slot=纯圆角矩形
  if (eye_style == "rings") {
    hull() {
      offset(r = corner_r)
        square([out_w - 2*corner_r, out_l - 2*corner_r], center = true);
      for (sx = [-1, 1]) translate([sx*eye_x, eye_cy, 0]) circle(d = eye_ring_d);
    }
  } else {
    offset(r = corner_r)
      square([out_w - 2*corner_r, out_l - 2*corner_r], center = true);
  }
}

module cav2d()   // 内腔轮廓（全开放电池舱）
  offset(r = in_r) square([inn_w - 2*in_r, inn_l - 2*in_r], center = true);

// ---------- 主壳（背面件） ----------
module shell() {
  difference() {
    union() {
      linear_extrude(shell_h) outer2d();
      for (sx = [-1,1], sy = [-1,1]) translate([sx*hole_dx, sy*hole_dy, 0]) {
        cylinder(d = boss_d, h = shell_h);                                  // 螺柱（通高）
        translate([0, 0, floor_t + bay_h]) cylinder(d = 9, h = pcb_gap);    // PCB 垫圈台
      }
    }
    translate([0, 0, floor_t]) linear_extrude(shell_h) cav2d();             // 电池舱（全开放）
    // M2 自攻引孔（上深 7）
    for (sx = [-1,1], sy = [-1,1])
      translate([sx*hole_dx, sy*hole_dy, shell_h - 7]) cylinder(d = pilot_d, h = 7.5);
    // USB-C 喇叭口（底边，外扩防插头磕碰）
    hull() {
      translate([-usb_w/2, -inn_l/2 - 1, usb_z0])
        cube([usb_w, wall + 2, shell_h - usb_z0]);
      translate([-usb_w/2 - 3, -out_l/2 - 1, usb_z0 - 1.0])
        cube([usb_w + 6, wall + 2, shell_h - usb_z0 + 1.0]);
    }

    // 拨动开关槽（顶边）
    translate([sw_x - 1.8, inn_l/2 - 1, pcb_z + pcb_t + 0.8]) cube([3.6, wall + 3, 2.4]);
    // 麦克风后腔（浅腔留密封膜）+ 背孔
    translate([mic_x - 3.5, mic_y - 3.5, 0]) cube([7, 7, floor_t - 0.4]);
    translate([mic_x, mic_y, -1]) cylinder(d = mic_d, h = floor_t + 2);
    // 挂绳样式开口（贯通背板）
    if (eye_style == "rings") {
      for (sx = [-1, 1]) translate([sx*eye_x, eye_cy, -1]) cylinder(d = eye_d, h = shell_h + 2);
    } else {
      translate([0, slot_cy, -1]) cube([slot_l, slot_w, floor_t + 2]);
    }
  }
  // 挂绳开口补强（填满下方电池舱空间，与面板环台/凸圈对接）
  if (eye_style == "rings") {
    for (sx = [-1, 1]) difference() {
      translate([sx*eye_x, eye_cy, floor_t]) cylinder(d = eye_ring_d, h = bay_h);
      translate([sx*eye_x, eye_cy, -1]) cylinder(d = eye_d, h = shell_h + 2);
    }
  } else {
    difference() {
      translate([0, slot_cy, floor_t]) linear_extrude(bay_h)
        offset(r = 4) square([slot_l + 8, slot_w + 8], center = true);
      translate([0, slot_cy, -1]) cube([slot_l, slot_w, shell_h + 2]);
    }
  }
  // 预留 LED 导光柱（PCB 顶面直通面板开孔）
  if (led_on)
    translate([led_x, led_y, pcb_z + pcb_t - 0.2]) cylinder(d = led_d + 1, h = shell_h - pcb_z - pcb_t + 0.2);
}

// ---------- 面板（正面件） ----------
module face() {
  difference() {
    union() {
      translate([0, 0, lip_d]) linear_extrude(face_t) outer2d();              // 正面皮
      linear_extrude(lip_d)                                                   // 裙边（插主壳内腔）
        difference() { offset(r = -0.15) cav2d(); offset(r = -1.35) cav2d(); }
      if (eye_style == "rings") {                                             // 挂绳孔正面环台
        for (sx = [-1, 1])
          translate([sx*eye_x, eye_cy, lip_d + face_t]) cylinder(d = eye_ring_d, h = 1.2);
      } else {                                                                // 横槽正面凸圈
        translate([0, slot_cy, lip_d + face_t]) linear_extrude(0.8) difference() {
          offset(r = 4) square([slot_l + 8, slot_w + 8], center = true);
          offset(r = 4) square([slot_l + 2, slot_w + 2], center = true);
        }
      }
      if (logo)
        translate([0, -out_l/2 + 8, lip_d + face_t])
          linear_extrude(0.5) text(logo_txt, size = 4.5, font = "Arial",
                                   halign = "center", valign = "center");
    }
    // 贴纸身份区凹槽（嵌印刷贴纸，覆膜更耐久）
    if (label_on)
      translate([label_cx - label_w/2, label_cy - label_h/2, lip_d + face_t - label_d])
        cube([label_w, label_h, label_d + 1]);
    // SSD1306 视窗（默认关，调试可开）
    if (win_on)
      translate([-win_w/2, win_cy - win_h/2, -1]) cube([win_w, win_h, lip_d + face_t + 2]);
    // 挂绳开口
    if (eye_style == "rings") {
      for (sx = [-1, 1]) translate([sx*eye_x, eye_cy, -1]) cylinder(d = eye_d, h = lip_d + face_t + 3);
    } else {
      translate([0, slot_cy, -1]) cube([slot_l, slot_w, lip_d + face_t + 2]);
    }
    // 预留按键孔（通孔 + 面板沉孔）
    if (btn_on) for (p = btn_positions) {
      translate([p[0], p[1], -1]) cylinder(d = btn_d, h = lip_d + face_t + 2);
      translate([p[0], p[1], lip_d + face_t - btn_cb_h]) cylinder(d = btn_cb_d, h = btn_cb_h + 1);
    }
    // LED 状态灯孔
    if (led_on) translate([led_x, led_y, -1]) cylinder(d = led_d, h = lip_d + face_t + 3);
    // 裙边让位：USB 喇叭口与开关槽
    translate([-usb_w/2 - 3, -inn_l/2 - 1.2, -1]) cube([usb_w + 6, 4.0, lip_d + 0.05]);
    translate([sw_x - 2.5, inn_l/2 - 1.6, -1]) cube([5, 3.2, lip_d + 0.05]);
  }
}

// ---------- 输出 ----------
if (part == "shell" || part == "all") shell();
if (part == "face")
  face();
if (part == "all")
  translate([0, 0, shell_h + part_gap]) face();

echo(str("A 外廓 XxYxZ = ", out_w, " x ", out_l, " x ", shell_h + face_t,
         " mm（挂绳环台局部 +1.2）"));
echo(str("A 内腔 = ", inn_w, " x ", inn_l, "  PCB底面z=", pcb_z,
         "  电池舱深=", bay_h, "  主壳高=", shell_h));
