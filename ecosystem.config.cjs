module.exports = {
  apps: [
    {
      name: 'web-im-chat',
      script: 'server.js',
      exec_mode: 'fork',
      instances: Number(process.env.PM2_INSTANCES || 1),
      time: true,
      env: {
        APP_ENV: process.env.APP_ENV || 'production',
        NODE_ENV: process.env.NODE_ENV || process.env.APP_ENV || 'production',
        PORT: process.env.PORT || 3000
      },
      env_development: {
        APP_ENV: 'development',
        NODE_ENV: 'development',
        PORT: process.env.PORT || 3000
      },
      env_production: {
        APP_ENV: 'production',
        NODE_ENV: 'production',
        PORT: process.env.PORT || 3000
      },
      max_memory_restart: '512M',
      listen_timeout: 10000,
      kill_timeout: 5000
    }
  ]
};
