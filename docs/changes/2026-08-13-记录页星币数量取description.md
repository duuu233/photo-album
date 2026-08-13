# 购买 & 消费记录页：「XXX 星币」的数量改取 `description`（2026-08-13）

> 状态：current
> 最后核对：2026-08-13
> 适用范围：微信小程序（`utils/token-api.js`、`subpackages/token/records`）
> 权威来源：产品口径（本轮一条）+ `GET /Client/Order/getUserAccountTrade` 出参实测
> ✅ **双端已同步**（Flutter 见 `flutter/docs/history/2026-08/2026-08-13-小程序08-11至08-13积压同步.md`
> 第十一节；⚠️ App 未编译未真机）
> 相关：[2026-08-08 微信虚拟支付对接](2026-08-08-微信虚拟支付对接.md)、
> [客户端接口矩阵](../reference/client-api-matrix.md)

## 问题

记录页每条右侧的「XXX 星币」取的是出参 `num`，而 `getUserAccountTrade`
（`ClientUserAccountTradeApiOut`）在这两类记录里**并不总是给 `num`**：这笔的数量后端写在
`description` 里（例：`200 token`）。于是页面上会出现自相矛盾的一行 ——
描述写着 `200 token`、右边却是 `0 星币`。

## 改法

数量一律**以 `description` 为准**（`utils/token-api.js` 新增 `tokensFromDescription`）：

- 取 `description` 里的第一个数字；
- 消费侧后端可能带负号（`-200 token`），一律取绝对值 —— 减号由页面自己写；
- **一个数字都没有时回落 `num`**：宁可退回旧口径，也不要把一条真实记录显示成 0；
- 购买、消费两个 tab 同一套取值，不给它们两种口径。

顺带一处版式：消费记录那一行的「场景」原样画 `description`，而数量已经在右边显示了——
`description` 若**只是个数量**（`^数字 (token|星币)?$`，见 `isQuantityOnlyDescription`）就不再重复
画一遍，那一行只剩「时间 + -200 星币」；带说明的 `description`（如 `AI 生图 30 token`）照常展示。

## 影响面

| 文件 | 改动 |
| --- | --- |
| `utils/token-api.js` | 新增 `tokensFromDescription` / `isQuantityOnlyDescription`；`normalizePurchaseRecord` 与 `normalizeSpendRecord` 的 `tokens` 改取 `description`（回落 `num`），消费侧 `scene` 去重 |
| `tests/token-pay.test.js` | 追加四例：购买/消费都取 `description`、纯数量不重复当场景、无数字回落 `num` |

## 待确认

1. **购买记录的「+ 赠送 N」仍取 `giveNum`**：若 `description` 里的数量已经是「含赠送的总数」，
   这一行会把赠送数重复呈现。需要后端明确 `description` 是基础数量还是总数。
2. `description` 的措辞由后端决定（现见「200 token」）。它若改成中文或带上更多说明，
   端上仍取第一个数字，不受影响；但**若某天写成「订单 202608130001 扣 30」这类带别的数字在前的句子，
   取值就会错** —— 届时需要后端给独立的数量字段（这才是正解）。

## 回归验证

- [x] `node tests/token-pay.test.js` 通过（含新增四例）；全量 `tests/*.test.js` 通过。
- [ ] 真机：买一档星币后进「购买 & 消费记录」，两个 tab 的数量都应与实际一致，不再出现 `0 星币`。
- [ ] 与后端确认上面两条「待确认」。
