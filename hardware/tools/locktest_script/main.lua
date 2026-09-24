-- BadgeCore 烧录锁验证脚本：刷入后每 5 秒打印一次 alive
PROJECT = "badgecore"
VERSION = "1.0.0"

log.info("main", "badgecore lock-test build")

sys = require("sys")

sys.taskInit(function()
    while true do
        log.info("main", "alive")
        sys.wait(5000)
    end
end)

sys.run()
