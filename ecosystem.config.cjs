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
