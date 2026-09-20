# 部署 Hearthkeeper 0.1.0

這個版本驗證 Discord 連線、服務選單與運作監控，尚不收集回報或執行管理處分。
部署需要一台可持續運作、能透過 HTTPS／WebSocket 連出 Discord 的 Linux 主機。
不需 GPU、AI 供應商帳號、對外網站埠或公開 callback 網址。

## Discord 設定

建立專用 Discord Application 與 Bot，僅啟用 Guild Install，使用 `bot` 與
`applications.commands` scopes。0.1.0 不要求 Administrator、Manage Roles、
Moderate Members 或 Message Content／Presence／Server Members 特權 intents。
指令回覆只對操作成員可見，不會自動發送私訊或張貼公告。

安裝目的地必須由管理員確認。只在該 guild 註冊指令；即使 bot 被加進其他 guild，
程式仍拒絕處理其他 guild 的互動。`register` 只替換此 app 在指定 guild 的指令。
新功能需要更多權限時，另行說明並核准，不能直接要求 Administrator。

## 執行環境

- Node.js 24 LTS；正式部署固定一個已驗證版本。
- 獨立使用者 `hearthkeeper`，無登入 shell，無額外 capabilities。
- `/opt/hearthkeeper/releases/<commit>`：該 commit 的程式與 build。
- `/opt/hearthkeeper/current`：已核准的版本連結。
- `/opt/hearthkeeper/node`：固定版本 Node.js 執行環境。
- `/etc/hearthkeeper/runtime.env`：root 擁有、0600，systemd 讀取後傳入程序。
- `/var/lib/hearthkeeper`：保留給未來持久資料；0.1.0 不儲存案件。

`runtime.env` 需要 `DISCORD_TOKEN`、`DISCORD_APPLICATION_ID`、`DISCORD_GUILD_ID`，
可選 `METRICS_PORT`，預設 11940。不要將真實值寫入 Git、命令列參數或公共 Issue。
範例中的環境變數不會自動載入 `.env`；可由 systemd EnvironmentFile 注入。

## 部署與驗證順序

1. 在乾淨 checkout 執行 `npm ci`、`npm run check`，提交及推送已驗證來源。
2. 從相同 pushed commit 建立 release；Linux 上再執行安裝、測試、型別檢查與 build。
3. 部署 [systemd unit](../deploy/hearthkeeper.service)，先用 `systemd-analyze verify` 驗證。
4. 機器人已獲邀進入指定 guild、憑證已妥善注入後，執行 `npm run register`；程式會讀回指令清單。
5. 啟動 `hearthkeeper.service`，確認服務為 active，且 `/readyz` 回傳 200。
6. 在指定 Discord 社群實際執行 `/ping` 與 `/hearthkeeper`，核對僅本人可見的回覆。

僅有 systemd active 不能代表 Discord 接線完成。缺少 guild、Gateway 尚未 ready 或斷線時，
`/readyz` 回傳 503。切勿在缺少 token 或 guild 時填入虛構值啟動正式服務。

## 監控

HTTP 只綁定 `127.0.0.1`，不接受環境變數改成公開地址。

| 路徑／指標 | 意義 |
|---|---|
| `/healthz` | 程序可回應 HTTP |
| `/readyz` | Discord Gateway 已 ready 且設定的 guild 可用 |
| `/metrics` | Prometheus 格式資料 |
| `hearthkeeper_gateway_ready` | gauge，連線可用為 1，否則為 0 |
| `hearthkeeper_interactions_total{action,outcome}` | counter；action 為 menu／ping／other，outcome 為 success／failure／denied |
| `hearthkeeper_interaction_ack_seconds{action}` | histogram；初次回應耗時 |

正式讀回可使用 `curl -fsS http://127.0.0.1:11940/readyz` 與同位址的 `/metrics`。
驗證 PromQL：`hearthkeeper_gateway_ready == 1`；
`sum(increase(hearthkeeper_interactions_total{outcome="failure"}[15m]))`。
監控整合只能加入這個 loopback target，不能對外公開監控埠。

一般日誌只有固定事件類型，不記錄 Discord ID、token、訊息內容或原始 SDK 錯誤。
這個版本沒有 HTTP／MCP 管理 API；MCP 不適用於這個 Discord 連線版本。

## 停止與回滾

SIGTERM 會將 readiness 降為 0，關閉 HTTP 與 Discord 連線。
需要回滾時停止專用服務，將 current 指向已驗證的前一 release，再啟動與讀回。
0.1.0 沒有資料庫 migration；未來導入案件資料後須另外驗證 schema 相容性。
停止機器人不會刪除 Discord 社群、頻道或其他 bot。
