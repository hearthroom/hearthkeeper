# Hearthkeeper 0.4：問題與回饋

功能異常、儲值問題、帳號問題、角色卡錯誤使用「問題」流程；審核疑問、角色卡檢舉使用「回饋」流程。舊一般回報沿用問題流程。表單仍填標題／內容，論壇標題只放使用者標題，首則內容保留原始日期。

| 時機／社管選擇 | 問題 | 回饋 |
|---|---|---|
| 新案 | 藍色等待中 | 藍色等待中 |
| 核准社管／技術角色回覆 | 白色處理中 | 白色處理中 |
| 未完成、鎖定並關閉 | 黃色暫停處理 | 黃色暫停處理 |
| 未完成、只鎖定 | 保留原狀態 | 黃色暫停處理 |
| 需要技術 | 橙色等待中（技術） | 不提供 |
| 需要討論 | 不提供 | 青色討論中 |
| PASS | 修復完成，綠色並關閉／鎖定 | 採納，綠色並關閉／鎖定 |
| 未採納 | 不提供 | 紅色並關閉／鎖定 |

社管選擇的橙色／青色保留至下次手動切換，後續回覆不覆蓋。沒有選過這兩種狀態的新案／待補充，社管回覆後轉白色。僅檢查回覆者角色與訊息 metadata，不讀取訊息正文或附件，也不要求 Message Content 特權 intent。

黃色由案件未完成及實際 archived／locked 旗標推導，沒有額外結案語意；恢復貼文會顯示暫停前的工作狀態。一般閒置封存不會變黃。已結案的 PASS／未採納不受後續 Discord 旗標變更覆蓋；重開案件才清除處理結果。

二級「貼文管理」面板提供對應工作狀態、處理結果與四種貼文操作。結果按鈕明示會關閉並鎖定，點擊後填寫處理理由，送出後才套用；理由可在「我的回報」查看。已關閉貼文可由作用中的頻道執行 `/cases` 開啟面板，已結案則先重開案件。

## 同步與資料

SQLite 新增 resolution（null／passed／not_adopted）；state=closed 仍控制配額與 90 天留存。舊 closed 不代表修復或採納，繼續顯示已結案。

ThreadUpdate 只處理設定論壇內已追蹤且由 bot 建立的貼文。重新 REST 讀回旗標，不使用可能過期的 Gateway payload。只有 fully synced 的案件可接受觀察；回寫以版本號再次檢查。自己的 outbox 在 pending 狀態執行，暫時解鎖不會被當成外部操作。觀察事件保存在 staff-only 歷史，不會發訊息或捏造人類操作人。

每 15 秒輪巡最多 20 個已同步案件，補回斷線／停機期間的變更；超過 20 案會續接游標。失敗會記固定事件／健康狀態，不記帳號、案件 ID 或內容。未完成的投影先處理已接受的操作，再由後續輪巡核對。Discord 本身不提供跨 REST 讀取與管理員操作的原子交易，兩者同時修改時下一輪以最終可讀旗標收斂。

標籤與二級按鈕使用 guild 自訂 emoji；部署設定列出名稱，執行時查 ID。沒有伺服器 ID 寫入公開程式碼，也不增設 AI 依賴。

依據：[Discord Thread metadata 與 Channel API](https://docs.discord.com/developers/resources/channel#thread-metadata-object)、[Thread Update](https://docs.discord.com/developers/events/gateway-events#thread-update)。鎖定控制一般成員重新開啟權限，不代表進行中的貼文禁止所有回覆；要停止一般貼文活動使用關閉並鎖定。

## 可觀測性與 MCP

沿用 `hearthkeeper_case_forum_ready` gauge（標籤、emoji、權限及輪巡成功為 1）、`hearthkeeper_case_pending` gauge，以及 `hearthkeeper_case_delivery_total{outcome}` counter 的 success/failure。ThreadUpdate 例外記 failure，週期輪巡失敗使 forum_ready=0；無新增含 ID 的 labels。驗證查詢：`hearthkeeper_case_forum_ready == 1`、`hearthkeeper_case_pending == 0`，及 failure counter 增量。Gateway readiness 與案件同步健康分開。

MCP 不適用：此功能只透過 Discord 授權的 guild 互動提供，沒有新增平台 HTTP／MCP API。

## 驗收路徑

1. 問題與回饋各提交一個明示虛構測試的案件，確認標題／日期、分類及藍色 emoji。
2. 社管回覆轉白；問題選等待技術，回饋選討論中，後續回覆保留指定狀態。
3. 使用原生 Discord 鎖定／關閉，確認兩種黃色條件；單純封存不變黃。恢復後保留原工作狀態。
4. 問題 PASS；回饋未採納及重開後 PASS，確認理由、標籤、archived／locked 及資料庫同步完成。
5. 檢查完整 npm run check、Linux 同集、健康指標，以及實際自訂 emoji 圖示。普通成員不能操作社管結果；既有匿名身分邊界維持。
