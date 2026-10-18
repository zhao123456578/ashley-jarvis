export const modelConfig = {
  helmetModelFile: 'model.glb',
  // 无光照预览开关：true 时关闭环境反射(IBL)与方向光，改用纯白高亮度环境光
  // 做平面漫反射（metalness=0 时不产生高光），呈现模型纯贴图象，便于观察
  // 模型自带的颜色与纹理。设回 false 即恢复正常打光。
  unlit: true,
  // 姿态：弧度值。rotationY 绕竖轴旋转，控制模型朝向。
  // 1.309(75°) 经用户确认为背面；正面 = 背面 + 180° = 255° ≈ 4.451 rad。
  // 需要微调朝向时改这个值即可。
  rotationX: 0,
  rotationY: 4.7096,
  rotationZ: 0,
  heightScale: 0.92,
  trimTopFraction: 0.12,
  chinCenterDrop: 0.18,
  chinFlatFraction: 0.34,
  focusPadding: 1.12,
  bottomFadeHeight: 0.06,
  assembleDuration: 2600,
  assembleSpread: 2.5,
  assembleDelay: 0.38,
  assemblePieceCount: 63,
  assembleFlash: 2.5,
  particleCount: 40000,
  particleDelay: 0.3,
  particleMinSize: 6,
  particleMaxSize: 24,
  particleSpread: 1.4,
  particleEdgeOverscan: 1.22,
  particleBlackColor: 0x1a1a1a,
  particleGoldColor: 0xffc107,
  faceplateMaterial: 'JarvisHelmetSurface',
  // 留空则不注入眼缝发光 shader（模型无自发光眼睛时使用）。
  eyeSurfaceMaterial: '',
  // 新模型自带 basecolor 贴图，降低金属度以保留贴图原色（metalness=1 会把
  // diffuse 置黑、仅保留 F0 高光色，破坏模型自带的上色）。
  faceplateMetalness: 0,
  faceplateRoughness: 0.5,
  faceplateClearcoatRoughness: 0.2,
  faceplateNormalSmoothingIterations: 6,
  faceplateNormalSmoothingStrength: 0.68,
  emissiveMaterialNames: [
    'PaletteMaterial001',
    'PaletteMaterial002',
    'PaletteMaterial003',
    'OpenSourceCyberPinkDetails',
    'OpenSourceCyberCyanDetails'
  ],
  primaryEmissiveMaterial: 'PaletteMaterial001',
  primaryEmissiveMultiplier: 3.2,
  eyeCoreColor: 0xe8ffff,
  eyeGlowColor: 0x00a2ff,
  emissiveColor: 0x8fefff,
  // 待机动画：空闲（idle）时偶尔左右/上下张望，或慢速自转一圈。
  // enabled=false 可完全关闭，模型静止。
  idleMotion: {
    enabled: true,
    minIntervalMs: 4000,   // 两次待机动作之间的最小间隔
    maxIntervalMs: 9000,   // 最大间隔（实际在 min~max 间随机）
    glanceYawDeg: 24,      // 左右张望的最大偏头角度（度）
    glancePitchDeg: 13,    // 上下张望的最大俯仰角度（度）
    spinChance: 0.25,      // 每次动作选择“慢速自转整圈”的概率（其余为张望）
    spinDurationMs: 7000   // 自转整圈的时长（毫秒），越小转得越快
  },
  // 全息投影模式：触发后模型变为半透明青色全息（扫描线+菲涅尔边缘光），
  // 从屏幕底部升起，展示一段时间后降落并恢复黑金原样。
  // 触发源：定时自动展示 / 语音“开启全息模式” / 托盘菜单手动开关。
  hologram: {
    enabled: true,          // 总开关：false 时所有触发均无效（托盘可实时切换）
    autoIntervalMs: 60_000, // 定时自动展示间隔；0 = 禁用定时触发
    durationMs: 12_000,     // 全息展示总时长（升起 + 停留 + 降落）
    riseMs: 1_600,          // 从底部升到目标位置所需时长
    color: 0x35e0ff,        // 全息主色（青色）
    scanlineSpacing: 9.0,   // 扫描线间距（世界空间密度，越小越密）
    scanlineSpeed: 0.35,    // 扫描线滚动速度
    fresnelPower: 2.6,      // 边缘光锐度（越大边缘越细）
    opacity: 0.42           // 全息主体基础透明度
  }
};
