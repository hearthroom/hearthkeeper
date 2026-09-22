# 部署 Hearthkeeper 0.5.0

這個版本提供 Discord 連線、一般回報處理與結案留檔，不執行管理處分。
部署需要一台可持續運作、能透過 HTTPS／WebSocket 連出 Discord 的 Linux 主機。
不需 GPU、AI 供應商帳號、對外網站埠或公開 callback 網址。

## Discord 設定

建立專用 Discord Application 與 Bot，僅啟用 Guild Install，使用 `bot` 與
`applications.commands` scopes。0.5.0 不要求 Administrator、Manage Roles、
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
- `/var/lib/hearthkeeper`：持久 SQLite 案件資料、WAL 及獨立清除清單。

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
0.2.0 首次啟動建立案件 schema。回滾至 0.1 不會處理既有案件；須保留資料目錄及金鑰，不能刪除資料。
停止機器人不會刪除 Discord 社群、頻道或其他 bot。

## 案件功能啟用

建立新的私人論壇，拒絕 @everyone 檢視，只允許核准社管角色與 Hearthkeeper。
機器人僅在該論壇取得檢視頻道、建立貼文、在貼文中傳送訊息、嵌入連結、讀取歷史及管理貼文權限。
若 Discord 畫面停用某權限，必須由具備該權限的管理員授予，不能繞過帳號權限。

將 `.env.example` 的全部 CASE_* 設定寫入受限環境檔；兩把 key 分別生成 32 隨機 bytes 並轉成 hex。
正式金鑰不得放入命令列、Git、Issue 或日誌；更換／遺失金鑰會使既有案件無法讀取，必須保留安全備份。
新增環境後重新註冊指令並重啟專用服務。先讀回論壇權限，再跑表單至結案的實際路徑。
檢查 `hearthkeeper_case_forum_ready == 1` 及 `hearthkeeper_case_pending == 0`，不能只看 `/readyz`。

保留期限、未知發送、加密及備份恢復邊界見 [0.2 設計](technical-design/Feedback_0.2.md)。
目前提供 Prometheus endpoint，沒有自行修改主機的 scrape 或告警設定。

## 0.3 分類與標籤設定

在專用私人論壇預先建立以下十一個標籤（名稱須完全一致）：
功能異常、儲值問題、帳號問題、角色卡錯誤、審核疑問、角色卡檢舉、🔵 等待中、⚪ 處理中、🟠 等待中（技術）、待補充、已結案。
標籤可由管理員設定，bot 不需要管理頻道權限。更新前讀回既有標籤，保留其他用途的標籤。
機器人管理自己的案件貼文標籤；手動加在這些案件上的其他標籤會在下次同步時移除。

新案會提及 CASE_STAFF_ROLE_IDS 的角色。若角色未開放提及，僅在案件論壇授予 bot
「提及 @everyone、@here 和所有身分組」權限；程式只允許指定社管角色被提及，
禁止正文、所有人或任意成員觸發通知。缺少標籤或提及權限時，forum-ready 為 0 並停止外部同步。

0.3 啟動會新增分類及貼文關閉／鎖定欄位。更新前建立一致的受限資料庫備份並保留原有金鑰，
舊案件分類設為一般回報，已結案案件保留鎖定／封存。既有案件下次操作時才更新論壇標籤。
回滾舊版不會刪除新增欄位，但舊版不理解獨立貼文狀態；重新上線前需核對案件投影。


## 0.4 問題／回饋狀態

0.4 取代上面的三個圓圈狀態標籤；保留六個分類、待補充及已結案標籤。
在更新前新增下列七個標籤並選擇同一伺服器的自訂表情符號，舊三個圓圈標籤可先保留。

| 標籤名稱 | 自訂表情符號名稱 |
|---|---|
| 等待中 | Waiting |
| 處理中 | Processing |
| 等待中（技術） | Waiting_engineer |
| 暫停處理 | In_Progress |
| 討論中 | under_discussion |
| PASS | Passed |
| 未採納 | Not_adopted |

名稱大小寫須一致，不能有重名表情符號；所有表情符號必須可供 bot 使用。
啟動與每次同步前驗證標籤 emoji ID 與伺服器表情符號一致。程式庫不保存實際伺服器 ID。
不必增加 bot 的管理頻道權限。既有案件在下次操作／同步時套用新標籤。

新增 nullable resolution 欄位，既有已結案資料仍是「已結案」，不推斷為 PASS。
新 under_discussion 狀態與 resolution 需要 0.4 才能理解；回滾前先停 bot，保存一致備份，
不要讓 0.3 同時處理已使用新流程的資料。舊欄位與金鑰均保留。

規則、驗收與可觀測性見 [0.4 設計](technical-design/Case_Workflows_0.4.md)。

## 0.5 私密對話入口

依 [0.5 權限表及驗收](technical-design/Private_Reports_0.5.md) 配置專用一般文字頻道與 `CASE_PRIVATE_PARENT_ID`，不改社管論壇的 @everyone deny。`CASE_PRIVATE_MAX_ACTIVE` 選填，預設 100；基礎 CASE_* 金鑰保持原值。

先跑完整可信集及精確來源發布，再驗證私人入口 ready、一般成員隔離、附件和結案鎖定；不得把 source build 或單一管理員帳號視角當完整權限驗收。

## 逐件審核通知

先部署 Hearthroom migration 0034 與 `/internal/community/*-v2` bridge，再部署 Bot。
在既有受限環境檔設定 `COMMUNITY_REVIEW_V2=true`；`COMMUNITY_REVIEW_LOCALE`
預設 `zh-Hant`，亦支援 zh-Hans、en、ja、ko。沿用私人 `COMMUNITY_REVIEW_CHANNEL`
及核准的 `CASE_STAFF_ROLE_IDS`，不新增 Discord 管理權限。Discord 管理員原有的
隱含存取不受頻道覆寫限制；一般角色若能看到此頻道，Bot 拒絕投遞。

每輪送審維持一則訊息，顯示卡名、初審／重審、通過人數、目前審核員、認領到期與
下一步。保留盲審；不傳作者、私有人設或駁回說明。成人作品在 Discord 只顯示分級
占位文字。認領 30 分鐘後產生一次站內提醒；Discord 私訊須同時開啟站內通知、私訊
且綁定有效。45 分鐘到期釋放。每日臺北時間 10:00 後摘要等待超過 24 小時的作品，
超過 48 小時標為「需協調」，不會自動裁決或點名催促。

上線會補入既有待審作品。一般狀態變更由 dirty delivery 優先處理；每 10 分鐘核對
待審訊息，每日核對終態訊息。Discord 刪文、Bot 重啟或 ack 遺失由 D1 message mapping、
SQLite receipt／發送嘗試與有界歷史掃描恢復。SQLite 必須保留；歷史超出恢復範圍時
停止該筆並報 failed，避免不確定情況重貼。頻道更換會在新核准頻道建立新訊息，
不自動刪除舊頻道紀錄。終態 mapping 保留 30 天，期滿後不再修復其 Discord 訊息。

部署前備份 SQLite；schema 為新增表，不刪除既有資料。回退 Bot 時把
`COMMUNITY_REVIEW_V2=false` 後重啟，使用原有通用提醒。勿回退 D1 migration。
新版 release／stamp 需要 claim generation；已開啟的舊審核頁需重新整理。
Bridge 不相容時 fail closed 並記錄 failed，由設定切回舊版，避免混送兩套通知。

監控：`hearthkeeper_review_delivery_total{kind,outcome}` counter，kind 只含
main/reminder/digest，outcome 只含 sent/updated/suppressed/failed；
`hearthkeeper_review_delivery_lag_seconds` histogram、`hearthkeeper_review_pending_deliveries`
gauge、`hearthkeeper_review_oldest_pending_age_seconds` gauge 與
`hearthkeeper_review_last_poll_timestamp_seconds` gauge。以 `/metrics` 讀回，或查
`sum(increase(hearthkeeper_review_delivery_total{outcome="failed"}[15m]))`、
`time()-hearthkeeper_review_last_poll_timestamp_seconds > 180`。未修改既有 Prometheus
scrape／告警設定；ID、作者、內容與憑證不進 labels 或 logs。

MCP：不適用。此功能為私人 Discord 通知投影；審核仍走既有受權限保護的網站流程，
不增加外部 AI 客戶端可操作的審核工具。
