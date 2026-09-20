# Hearthkeeper · 爐邊管家

Hearthkeeper 是為 HearthRoom 角色卡社群設計的開源 Discord 管理機器人。
它讓成員提出建議、回報問題與申訴，讓社管認領案件、回覆並保存處理結果。

**目前是設計階段，尚無可執行的機器人。** 本倉庫不會自動連接 Discord、
建立頻道或變更社群設定。第一版以服務選單、匿名代轉、私密回報與管理紀錄為主。

## 閱讀入口

- [產品需求與版本範圍](docs/requirements.md)：給社管與貢獻者。
- [技術設計 V1.0](docs/technical-design/Hearthkeeper_TechnicalDesign_20260920_V1.0.md)：流程、權限、資料生命週期與驗收。
- [貢獻方式與提交身分](CONTRIBUTING.md)：如何提出修改及使用專案身分。
- [安全問題回報](SECURITY.md)：避免將私密案件放進公開 Issue。

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
