# Supplier Wizard

交互式收集供应商名称、Base URL、API Key 和模型信息，生成不含密钥的配置，并以进程环境变量临时注入 API Key，调用标准 `onboard` pipeline。

```powershell
python tools/supplier-wizard/wizard.py
```

默认输出到 `.local-sub2api-release/runtime/supplier-wizard/`：

- `*-onboarding.json`：不含密钥的 onboarding 配置；
- `*-onboarding-probe.json`：统一 onboarding 报告；
- `*-onboarding-probe-artifacts/`：兼容性报告、风险报告、配置模板和统一报告；
- `*-wizard-report.json`：含命名、定价计算和 pipeline 结论的 Wizard 报告。

指定输出位置：

```powershell
python tools/supplier-wizard/wizard.py `
  --config-output .local-sub2api-release/runtime/my-supplier.json `
  --report-output .local-sub2api-release/runtime/my-supplier-report.json
```

标准顺序为 `probe → fingerprint → apply → verify`。若 probe 未通过，向导会停止在评估阶段，不写 Sub2API。若通过，`apply` 使用既有的 Sub2API 管理员环境变量和可选的下游验证凭据，创建/更新原生 group、account 与测试 key 绑定后完成 verify。
