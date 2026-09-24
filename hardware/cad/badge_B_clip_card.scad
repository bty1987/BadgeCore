// =====================================================================
// BadgeCore 形态B · 横版胸牌外壳（参数化 3D 打印设计稿 v5）
// v5（09-20 拍板 D21）：胸牌基本不搞屏幕——面板=贴纸名牌凹槽（参照 DuDuTalk 的
//   印刷名牌面）+ 低耗 LED 状态灯；板载 SSD1306 默认不开窗（调试可开 win_on）。
// v4（09-20，参照市场样机图）：B 改「横版名牌」方向——宽 88.0 × 高 57.0 横条，
//   全包裹，厚 11.2，约 44g；PCB 壳内横置 90°。对比 A 竖版 57.4×88.4×12.4。
// 诚实边界：85×54 PCB 决定包络，横条高度 57 由板宽决定；90×35 扁条需复刻 v2 小板。
// 使用：OpenSCAD 打开本文件 → part 选 shell / face → F6 渲染 → Export STL。
// =====================================================================

part = "all";   // [all, shell, face]

/* [PCB · 到货实测后修改]（壳内横置：PCB 长边沿整机 X） */
pcb_l   = 85.0;  // PCB 长边（=整机横向）
pcb_w   = 54.0;  // PCB 短边（=整机纵向）
pcb_t   = 1.6;
hole_in = 4.0;   // 安装孔中心到板边（四角对称）

/* [壳体] */
wall     = 1.2;  // 侧壁厚
floor_t  = 1.2;  // 主壳背板厚
face_t   = 1.0;  // 面板皮厚
clr      = 0.3;  // PCB 单边间隙
corner_r = 10.0; // 外壳圆角（横条名牌的圆润观感）
lip_d    = 2.6;  // 面板裙边插入深度

/* [电池] 默认 303035 锂聚合物 250mAh（35x30x3 薄型），横放 */
bat_l  = 35;   // X 向（整机横向）
bat_w  = 30;   // Y 向
bat_h  = 3.0;
bat_cy = 4;    // 电池中心 Y
bay_extra = 0.6;
pcb_gap   = 0.4;

/* [面板构成 · 整机坐标] 贴纸名牌面 + LED 状态灯（D21：基本不搞屏幕） */
label_on = true;
label_w  = 56; label_h = 26; label_cx = 0; label_cy = -5; label_d = 0.4; // 名牌贴纸凹槽（公司/姓名印刷贴纸）
win_on   = false;  // 板载 SSD1306 视窗：默认不开（调试时开，并把 label_on 关掉避让）
win_w    = 25.2; win_h = 9.4; win_cx = 0; win_cy = 14;
led_on   = true; led_x = 32; led_y = 6; led_d = 3.0;  // 低耗 LED 状态灯（贴纸区右侧）

/* [麦克风] 背出声，左下圆点 */
mic_x = -20; mic_y = -16;
mic_d = 2.0;

/* [侧壁开口 · 整机坐标] */
sw_x    = 25;     // 拨动开关 X（顶边）
usb_w   = 10.2;   // USB-C 过孔宽（底边，孔顶到主壳顶面）
usb_zin = 0.3;    // 孔下沿低于 PCB 顶面的距离

/* [背面背戴] */
back_style = "clip";  // [clip, magnet, plain]
clip_l = 32; clip_w = 10; clip_h = 1.1; clip_cy = -16; // 金属弹簧背夹槽
mag_d  = 12.6; mag_h = 1.1; mag_cy = -22;              // 磁吸盘（配 3M 胶；慎用：对磁条卡有风险）

/* [装配/其他] */
boss_d  = 5.0; pilot_d = 1.7;  // M2 自攻，配 M2x6
logo    = true; logo_txt = "BadgeCore";
part_gap = 8;
comp_h   = 3.4;  // PCB 顶面最高元件预留
$fn = 48;

/* ---- 派生尺寸（勿手改） ---- */
inn_x = pcb_l + 2*clr;   inn_y = pcb_w + 2*clr;
out_x = inn_x + 2*wall;  out_y = inn_y + 2*wall;
in_r  = corner_r - wall;
bay_h   = bat_h + bay_extra;
pcb_z   = floor_t + bay_h + pcb_gap;
shell_h = pcb_z + pcb_t + comp_h;
hole_cx = pcb_l/2 - hole_in;  hole_cy = pcb_w/2 - hole_in;
usb_z0  = pcb_z + pcb_t - usb_zin;

// ---------- 2D 轮廓 ----------
module outer2d()
  offset(r = corner_r) square([out_x - 2*corner_r, out_y - 2*corner_r], center = true);

module cav2d()
  offset(r = in_r) square([inn_x - 2*in_r, inn_y - 2*in_r], center = true);

// ---------- 主壳（背面件） ----------
module shell() {
  difference() {
    union() {
      linear_extrude(shell_h) outer2d();
      for (sx = [-1,1], sy = [-1,1]) translate([sx*hole_cx, sy*hole_cy, 0]) {
        cylinder(d = boss_d, h = shell_h);                                  // 螺柱（通高）
        translate([0, 0, floor_t + bay_h]) cylinder(d = 8, h = pcb_gap);    // PCB 垫圈台
      }
    }
    translate([0, 0, floor_t]) linear_extrude(shell_h) cav2d();             // 全开放电池舱
    // M2 自攻引孔（上深 7）
    for (sx = [-1,1], sy = [-1,1])
      translate([sx*hole_cx, sy*hole_cy, shell_h - 7]) cylinder(d = pilot_d, h = 7.5);
    // USB-C 喇叭口（底边，外扩防插头磕碰）
    hull() {
      translate([-usb_w/2, -inn_y/2 - 1, usb_z0])
        cube([usb_w, wall + 2, shell_h - usb_z0]);
      translate([-usb_w/2 - 3, -out_y/2 - 1, usb_z0 - 1.0])
        cube([usb_w + 6, wall + 2, shell_h - usb_z0 + 1.0]);
    }
    // 拨动开关槽（顶边）
    translate([sw_x - 1.8, inn_y/2 - 1, pcb_z + pcb_t + 0.8]) cube([3.6, wall + 3, 2.4]);
    // 麦克风后腔（留密封膜）+ 背孔
    translate([mic_x - 3.5, mic_y - 3.5, 0]) cube([7, 7, floor_t - 0.4]);
    translate([mic_x, mic_y, -1]) cylinder(d = mic_d, h = floor_t + 2);
    // 背面背戴结构（嵌入背板，背面平整）
    if (back_style == "clip")
      translate([-clip_l/2, clip_cy - clip_w/2, -0.01]) cube([clip_l, clip_w, clip_h]);
    if (back_style == "magnet")
      translate([0, mag_cy, -0.01]) cylinder(d = mag_d, h = mag_h);
  }
  // 预留 LED 导光柱（PCB 顶面直通面板开孔）
  if (led_on)
    translate([led_x, led_y, pcb_z + pcb_t - 0.2])
      cylinder(d = led_d + 1, h = shell_h - pcb_z - pcb_t + 0.2);
}

// ---------- 面板（正面件） ----------
module face() {
  difference() {
    union() {
      translate([0, 0, lip_d]) linear_extrude(face_t) outer2d();              // 正面皮
      linear_extrude(lip_d)                                                   // 裙边（插主壳内腔）
        difference() { offset(r = -0.15) cav2d(); offset(r = -1.35) cav2d(); }
      if (logo)
        translate([0, -out_y/2 + 5, lip_d + face_t])
          linear_extrude(0.5) text(logo_txt, size = 4.5, font = "Arial",
                                   halign = "center", valign = "center");
    }
    // 贴纸名牌凹槽（嵌印刷贴纸，覆膜更耐久）
    if (label_on)
      translate([label_cx - label_w/2, label_cy - label_h/2, lip_d + face_t - label_d])
        cube([label_w, label_h, label_d + 1]);
    // SSD1306 视窗（默认关，调试可开）
    if (win_on)
      translate([win_cx - win_w/2, win_cy - win_h/2, -1]) cube([win_w, win_h, lip_d + face_t + 2]);
    // LED 状态灯孔
    if (led_on) translate([led_x, led_y, -1]) cylinder(d = led_d, h = lip_d + face_t + 3);
    // 裙边让位：USB 喇叭口与开关槽
    translate([-usb_w/2 - 3, -inn_y/2 - 1.2, -1]) cube([usb_w + 6, 4.0, lip_d + 0.05]);
    translate([sw_x - 2.5, inn_y/2 - 1.6, -1]) cube([5, 3.2, lip_d + 0.05]);
  }
}

// ---------- 输出 ----------
if (part == "shell" || part == "all") shell();
if (part == "face")
  face();
if (part == "all")
  translate([0, 0, shell_h + part_gap]) face();

echo(str("B(v4 横版名牌) 外廓 XxYxZ = ", out_x, " x ", out_y, " x ", shell_h + face_t, " mm"));
echo(str("B(v4) 内腔 = ", inn_x, " x ", inn_y, "  PCB底 z=", pcb_z,
         "  电池舱深=", bay_h, "  主壳高=", shell_h, "  背戴=", back_style));
