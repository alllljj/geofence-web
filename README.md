# 电子围栏 · 远程监控网页

ESP32-S3 + SIM7670G 4G 电子围栏设备的远程监控网页。

## 访问地址

**https://alllljj.github.io/geofence-web/**

手机在任何网络（4G/5G/WiFi）打开即可使用。

## 功能

- 🗺️ 地图显示设备实时位置（每 2 分钟更新）
- ⚠️ 进圈报警状态（红色横幅 + 状态灯）
- ✏️ 在地图上点击绘制围栏多边形 → 一键下发到设备
- 📋 手动输入坐标下发围栏
- 🗑️ 清除围栏
- 📡 显示卫星数、距围栏距离

## 架构

```
手机浏览器 → GitHub Pages (本网页)
    ↓ fetch
position.json (GitHub Actions 每 2 分钟写入)
    ↓ TCP cmd=3 拉取
巴法云 TCP (bemfa.com:8344)
    ↓ 4G
ESP32-S3 设备 (30 秒上报一次坐标)
```

围栏指令下发：网页 → 巴法云 HTTP sendMessage → 设备 TCP 接收 → 更新围栏并保存 NVS

## 部署配置

- `BEMFA_UID`：巴法云私钥（GitHub Actions Secret）
- `BEMFA_TOPIC`：主题名 geofence001（GitHub Actions Secret）
- 网页内 `index.html` 顶部的 `BEMFA_UID` / `TOPIC` 常量需与实际一致

## 维护

- 位置同步：`.github/workflows/sync-position.yml`（每 2 分钟自动拉取设备坐标写入 position.json）
- 手动触发：Actions 页面 → Sync device position → Run workflow
