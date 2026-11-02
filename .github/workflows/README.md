> 这份说明同时给人和 npm 的绑定页面看：npm 的 Trusted Publisher 表单要求填
> 「workflow filename」，必须与下方 `name` 所在文件的文件名完全一致 —— 也就是
> `release.yml`（只填文件名，不带路径，但要带 `.yml`）。
## 这个工作流做什么
打一个 `v*` 的 tag 并推送，GitHub 就会自动把当前版本发布到 npm。
**它不需要任何 npm token、也不需要 2FA 验证码。** npm 通过 OIDC 信任这个
workflow，等效于「本人亲自发布」，这正是它绕开两步验证的原因。
## 为什么用它（而不是 `npm publish --otp=`）
本机账号的 2FA 绑的是**安全密钥（passkey）**，而 npm 命令行的 `--otp`
只接受**认证器 6 位数字码**，两者不通用；npm 的暂存批准页面又没有网页入口。
Trusted Publishing 因此成为唯一无码可用的官方通道，也是 npm 自己推荐的替代方案。
## 首次启用要做的两件事
1. **npm 侧绑定**：npmjs.com → 该包 → Settings → **Trusted Publisher** →
   选 **GitHub Actions**，填：
   - Organization or user：`dawanglaohu`
   - Repository：`dsh-xdpool`
   - Workflow filename：`release.yml`
   - Environment name：留空
   - Allowed actions：按需勾选（**至少保留 `npm stage publish`**；
     勾上 direct publish 才能一步到位发布）
2. **GitHub 侧**：确认仓库的 Actions 有写权限（默认有），然后推送一个 tag 即可。
## 发布一个新版本
```powershell
cd D:\xiangmu\dsh-xdpool
# 1. 改 package.json 的 version，并同步写 CHANGELOG
# 2. 提交
git add -A
git commit -m "release: x.y.z"
# 3. 打 tag 并推送 —— 这一步就会触发自动发布
git tag vX.Y.Z
git push origin main
git push origin vX.Y.Z
```
推送后到仓库的 **Actions** 页看进度，几十秒即可在 npm 上看到新版本。
> 注意：npm 的 staged publishing 策略下，若绑定页面只勾了 `npm stage publish`，
> 发布仍会停在暂存区等待批准 —— 那种情况下这条通道也帮不上忙，所以**建议把
> direct publish 一并勾上**，让 workflow 直接正式发布。

## 本仓库（dawanglaohu/dsh-xdpool）是 fork：OIDC 身份不被 npm 认
上面那套 Trusted Publisher 绑定的是**上游** `XDTrees/dsh-xdpool` —— 上游推
tag 能发（2.5.1 的 Release run 是 success），本 fork 推 tag 会在 `npm publish`
这一步拿到：

```
npm error code E404
npm error 404 Not Found - PUT https://registry.npmjs.org/dsh-xdpool - Not found
npm error 404  The requested resource 'dsh-xdpool@2.5.2' could not be found or you do not have permission to access it.
```

这个 404 **不是「包不存在」**（包在，`npm view dsh-xdpool version` 回 `2.5.1`），
而是 npm 对未授权 publish 故意回 404 以免暴露包是否存在。OIDC token 的 subject
里带 `dawanglaohu/dsh-xdpool`，而 npm 侧信任清单里只有 `XDTrees/dsh-xdpool`。

要修，二选一：

1. npmjs.com → 该包 → Settings → Trusted Publisher → **再加一条**绑定，
   Repository 填 `dawanglaohu/dsh-xdpool`（同一个包可以绑多个仓库）；
2. 在本仓库配一个 npm 自动化 token secret（如 `NPM_TOKEN`），并在
   `release.yml` 里把 `NPM_CONFIG_USERCONFIG` 指到带该 token 的 `.npmrc`
   —— 但这样又回到需要 token 的老路。

## 版本号要跨过上游
本 fork 的 tag 序列与上游独立，但**发布到同一个 npm 包**。上游已经发过
`2.5.1`，所以本 fork 不能发 `2.4.10` 之类更低的号：

```
npm error Cannot implicitly apply the "latest" tag because previously published
version 2.5.1 is higher than the new version 2.4.10. You must specify a tag using --tag.
```

所以 fork 侧的版本号要往 2.5.2 及以上走（本 fork 走 git tag 安装时无所谓，
但一旦要走 npm 就必须遵守）。
