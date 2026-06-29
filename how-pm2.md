# PM2 常用命令小结

### Fork模式
pm2 start app.js --name app # 设定应用的名字为 app

## Cluster模式

### 使用负载均衡启动4个进程
pm2 start app.js -i 4     

### 将使用负载均衡启动4个进程，具体取决于可用的 CPU
pm2 start app.js -i 0   

### 等同于上面命令的作用
pm2 start app.js -i max 

### 给 app 扩展额外的3个进程
pm2 scale app +3

### 将 app 扩展或者收缩到2个进程
pm2 scale app 2              

## 查看应用状态

### 展示所有进程的状态
pm2 list  

### 用原始 JSON 格式打印所有进程列表
pm2 jlist

### 用美化的 JSON 打印所有进程列表
pm2 prettylist  

### 展示特定进程的所有信息
pm2 describe 0

### 使用仪表盘监控所有进程
pm2 monit             

### 日志管理

### 实时展示所有应用的日志
pm2 logs          

### 实时展示 app 应用的日志 
pm2 logs app

### 使用json格式实时展示日志，不输出旧日志，只输出新产生的日志
pm2 logs --json

## 应用管理

### 停止所有进程
pm2 stop all

### 重启所有进程
pm2 restart all       

### 停止指定id的进程
pm2 stop 0     

### 重启指定id的进程
pm2 restart 0         

### 删除id为0进程
pm2 delete 0

### 删除所有的进程
pm2 delete all         
