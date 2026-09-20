# 貢獻方式

本專案目前接受設計討論與文件修改。請先閱讀 [需求](docs/requirements.md)，
再提出有具體使用情境的 Issue 或 Pull Request。請使用虛構資料重現問題。

## 提交身分

專案維護者使用 `Hearth Room <contact@hearthroom.club>`。
請在此倉庫設定本機 Git 身分，不要更動其他專案或全域設定：

```sh
git config --local user.name 'Hearth Room'
git config --local user.email 'contact@hearthroom.club'
git config --local user.useConfigOnly true
git config --local user.signingkey ''
git config --local commit.gpgsign false
git config --local tag.gpgsign false
```

外部貢獻者可使用自己的公開身分或化名；不需冒用維護者身分。
匿名維護者應另行確認 GitHub 帳號、組織公開成員資料與發布紀錄不會連到私人身分。
Git 本機設定無法隱藏 GitHub 的操作帳號，也無法清除既有歷史。

提交與發布前檢查：

```sh
git var GIT_AUTHOR_IDENT
git var GIT_COMMITTER_IDENT
git log -1 --format=fuller
git diff --cached --check
```

`GIT_AUTHOR_*`、`GIT_COMMITTER_*`、`--author`、cherry-pick、amend 及自動化程式
可能帶入不同身分。Author 和 Committer 都要核對，提交訊息中的署名也要檢查。
既有歷史若需要改寫，必須另外規劃，不能靠改 `git config` 宣稱已完成。

## 公開內容

不要提交 Bot Token、Discord 實際頻道或使用者識別資料、案件匯出、附件、
備份、個人路徑或私人操作紀錄。公開範例只能使用明確的占位文字與虛構案例。
著作權及第三方授權資訊應保留，不以匿名化為由刪除。

## 驗證方式

目前只有文件，修改時檢查連結、Markdown、圖表和需求一致性。
實作開始後，行為修改須先用失敗測試證明問題，再完成修正。
權限與匿名測試須包含一般成員、承辦社管和維運者等不同角色。
