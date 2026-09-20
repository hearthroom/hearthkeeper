# Hearthkeeper · 爐邊管家

Hearthkeeper 是為 HearthRoom 角色卡社群設計的開源 Discord 管理機器人。
它讓成員提出建議、回報問題與申訴，讓社管認領案件、回覆並保存處理結果。

**0.1.0 提供連線與部署基礎。** `/hearthkeeper` 開啟社群與指南選單，`/ping` 驗證回應。
回報、案件追蹤、通知身分組與處分功能尚未實作；設計文件描述的是後續目標。
目前只接收 slash command，不讀取一般聊天、不需要 AI，也不保存使用者或案件資料。

## 執行

使用 Node.js 24 LTS，執行 `npm ci` 與 `npm run check` 完成測試及建置。
依 `.env.example` 設定環境變數後，`npm run register` 註冊指定社群的指令，
`npm start` 啟動 Gateway 連線。一般啟動不會自動覆寫指令或建立頻道。
正式環境請依 [部署說明](docs/deployment.md) 使用專用服務帳號。

## 閱讀入口

- [產品需求與版本範圍](docs/requirements.md)：給社管與貢獻者。
- [技術設計 V1.0](docs/technical-design/Hearthkeeper_TechnicalDesign_20260920_V1.0.md)：流程、權限、資料生命週期與驗收。
- [貢獻方式與提交身分](CONTRIBUTING.md)：如何提出修改及使用專案身分。
- [安全問題回報](SECURITY.md)：避免將私密案件放進公開 Issue。
- [部署說明](docs/deployment.md)：Bot 權限、環境變數、systemd 與健康監控。

## 設計原則

- 回報人能隨時查看自己的案件，不依賴 Discord 私訊是否開啟。
- 匿名代轉向一般承辦社管隱藏帳號；不承諾對服務維運者或 Discord 匿名。
- 論壇只供授權社管處理案件，成員不會因此看見其他人的回報。
- 公開建議須經投稿人同意；私密檢舉不自動轉成公開討論或 GitHub Issue。
- 社群管理員決定處分。第一版不使用 AI 自動判罰。

## 專案與授權

原始碼位置：<https://github.com/hearthroom/hearthkeeper>。
專案採 [GNU AGPL v3](LICENSE)。部署者自行保管憑證、案件資料及備份；
開源範圍不包含實際社群設定、身分對應或回報內容。
