# 小鲸鱼的空间与个人资料

使用已有 SnowLuma OneBot 客户端操作机器人自身账号，无新增依赖、Cookie配置、浏览器或后台服务。

四个工具：查看现状、发布动态、修改昵称/签名/性别、修改头像。图片可来自表情库存、当前聊天图片消息、公开图片URL；不接收任意本地路径或原始API动作。昵称修改同时同步QQ Agent的显示名和@识别，角色卡与botName保持原有身份。

默认已授权在聊天运行时自主使用；不需要管理员逐次确认。没有安排无人聊天时的定时发布。可在技能设置中关闭自主使用或单独关闭发布、资料、头像。

默认好友可见，每天最多6条动态，两条间隔30分钟；资料/头像间隔60分钟。上限和间隔可设0解除。仅自己可见对应SnowLuma的64，部分好友可见16未暴露，避免名单歧义。正文上限600字。动态不加群名/私聊昵称前缀，不自动搬运聊天隐私。

操作记录位于data/qq-self/state.json，只保存最近7天、最多200条操作的结果、内容摘要所需正文和哈希，不保存登录凭证。成功结果去重；发送超时记录为unknown，读最近说说核对，不盲目重发。关闭技能后停止写操作。演练模式不调用任何写接口。

配图复用image-ref-hint的QQ链接刷新与代理兼容。上传缓存位于data/qq-self/media，保留原始GIF而非看图抽帧结果，单图最多6MB、每次最多9张，自动清理7天前本功能创建的图片。QQ消息ID支持正负数。

工具注册与QQ读取通过本地实测；发布/资料/头像写入应按实际QQ接口结果判断。接口接受和客户端最终显示可能有缓存延迟，工具分别标记acknowledged/verified，不能编造成功。

API依据：

- https://snowluma.github.io/zh/docs/api/qzone/send_qzone_msg
- https://snowluma.github.io/zh/docs/api/qzone/get_qzone_msg_list
- https://snowluma.github.io/zh/docs/api/extended/set_qq_profile
- https://snowluma.github.io/zh/docs/api/extended/set_qq_avatar

本地版本1.0.0-local，2026-10-08。
