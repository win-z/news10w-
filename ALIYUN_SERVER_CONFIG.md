# 阿里云服务器配置说明

本文档记录新闻监控工具在阿里云服务器上的部署、端口、进程和代理配置。

## 服务器信息

- 公网 IP：`101.37.159.90`
- 系统：`Ubuntu 24.04.2 LTS`
- SSH 用户：`root` / `admin`
- SSH 端口：`22`
- 宝塔面板：`https://101.37.159.90:14648/a2443362`

不要把宝塔密码、SSH 私钥、代理订阅链接写入仓库。

## 对外访问地址

- 新闻监控工具：`http://101.37.159.90:3001`
- 原有旧服务：`http://101.37.159.90:3000`
- Nginx 默认站点：`http://101.37.159.90`

## 端口规划

| 端口 | 监听范围 | 用途 |
| --- | --- | --- |
| `22` | `0.0.0.0` / `[::]` | SSH 登录 |
| `80` | `0.0.0.0` | Nginx 默认站点 |
| `14648` | `0.0.0.0` | 宝塔面板 |
| `3000` | `*` | 原有 `lumina-backend` 服务 |
| `3001` | `*` | 新闻监控工具 |
| `7890` | `127.0.0.1` | mihomo 本机 HTTP/SOCKS 混合代理 |
| `9090` | `127.0.0.1` | mihomo 本机控制接口 |

`7890` 和 `9090` 只监听本机，不对公网开放。

## 新闻监控工具

部署目录：

```bash
/www/wwwroot/news-monitor
```

PM2 进程名：

```bash
news-monitor
```

PM2 配置文件：

```bash
/www/wwwroot/news-monitor/ecosystem.config.cjs
```

核心环境变量：

```js
{
  NODE_ENV: "production",
  PORT: "3001",
  CHROME_PATH: "/snap/bin/chromium"
}
```

本地数据文件：

```bash
/www/wwwroot/news-monitor/data/db.json
```

当前应用代理设置：

```json
{
  "proxyUrl": ""
}
```

## 常用命令

查看新闻监控服务状态：

```bash
pm2 status
pm2 logs news-monitor --lines 100 --nostream
```

重启新闻监控服务：

```bash
pm2 restart news-monitor --update-env
```

检查本机服务是否正常：

```bash
curl -I http://127.0.0.1:3001
curl -s http://127.0.0.1:3001/api/news
```

检查外网是否可访问：

```bash
curl -I http://101.37.159.90:3001
```

查看监听端口：

```bash
ss -lntp | grep -E ':22|:80|:3000|:3001|:7890|:9090|:14648'
```

## Mihomo / Clash 配置

安装路径：

```bash
/usr/local/bin/mihomo
```

配置目录：

```bash
/etc/mihomo
```

主配置文件：

```bash
/etc/mihomo/config.yaml
```

systemd 服务：

```bash
/etc/systemd/system/mihomo.service
```

服务状态：

```bash
systemctl status mihomo --no-pager -l
systemctl is-active mihomo
```

重启 mihomo：

```bash
systemctl restart mihomo
```

测试本机代理端口：

```bash
curl -x http://127.0.0.1:7890 -I http://www.baidu.com
```

当前 mihomo 已导入订阅中的 Trojan 节点，并配置为本机代理入口：

```yaml
mixed-port: 7890
allow-lan: false
bind-address: 127.0.0.1
external-controller: 127.0.0.1:9090
```

`allow-lan: false` 表示代理只供服务器本机使用，公网无法直接访问该代理端口。

## 防火墙与安全组

阿里云安全组和宝塔防火墙需要放通：

```text
22/tcp
80/tcp
14648/tcp
3001/tcp
```

服务器系统防火墙可检查：

```bash
ufw status
iptables -S | head -40
```

如 SSH 外部无法连接，但服务器内部 `ss` 显示 `22` 正在监听，可临时插入规则：

```bash
iptables -I INPUT 1 -p tcp --dport 22 -j ACCEPT
iptables -I INPUT 1 -p tcp --dport 3001 -j ACCEPT
```

## 部署流程

本地打包：

```bash
COPYFILE_DISABLE=1 tar --no-xattrs -czf /tmp/news-monitor.tar.gz \
  server.js package.json package-lock.json README.md Dockerfile .dockerignore public .gitignore
```

上传：

```bash
scp -i ~/.ssh/id_antigravity /tmp/news-monitor.tar.gz root@101.37.159.90:/tmp/news-monitor.tar.gz
```

服务器部署：

```bash
APP_DIR=/www/wwwroot/news-monitor
mkdir -p "$APP_DIR"
cd "$APP_DIR"
pm2 stop news-monitor 2>/dev/null || true
find . -mindepth 1 ! -path "./data" ! -path "./data/*" -exec rm -rf {} + 2>/dev/null || true
tar -xzf /tmp/news-monitor.tar.gz
find . -name "._*" -delete
npm install --omit=dev
```

创建 PM2 配置：

```bash
cat > ecosystem.config.cjs <<'EOF'
module.exports = {
  apps: [{
    name: "news-monitor",
    script: "server.js",
    cwd: "/www/wwwroot/news-monitor",
    env: {
      NODE_ENV: "production",
      PORT: "3001",
      CHROME_PATH: "/snap/bin/chromium"
    }
  }]
};
EOF
```

启动：

```bash
pm2 delete news-monitor 2>/dev/null || true
pm2 start ecosystem.config.cjs
pm2 save
curl -I http://127.0.0.1:3001
```

## 注意事项

- `3000` 是原有旧服务，不要覆盖或杀掉。
- `news-monitor` 使用 `3001`。
- `data/db.json` 是运行数据，部署时应保留。
- 代理订阅链接属于敏感凭证，不要提交到 Git，不要贴到公开截图。
- 如果重置了代理订阅，需要重新生成 `/etc/mihomo/config.yaml` 并重启 `mihomo`。
