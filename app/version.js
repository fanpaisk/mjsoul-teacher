'use strict';
/**
 * 版本号唯一来源。
 *
 * 之前版本号散落在：userscript 头部 @version、README、安装器脚本、以及"根本没有"
 * （服务端 live_coach.js 里没有任何版本常量）。四处各写一份必然漂移，
 * 而漂移的表现是"面板 v1.24 / 安装器 v1.25 / 日志里查不到版本"，排障第一步就卡住。
 *
 * 现在只认 package.json。userscript 的 @version 由服务端在 /coach.user.js 里注入，
 * 安装器与托盘壳在构建时读同一个文件。
 */
const path = require('path');

let version = '0.0.0';
let productName = '雀魂教练';
try {
  const pkg = require(path.join(__dirname, '..', 'package.json'));
  version = pkg.version || version;
  productName = pkg.productName || productName;
} catch (e) {
  // 打包裁剪掉 package.json 时不该炸掉整个服务端
}

module.exports = {
  version,
  productName,
  /** 带产品名的版本串，给日志/接口/面板统一用 */
  display() { return `${productName} v${version}`; },
};
