// fixture：根包干扰项 config——配合 dev:ghost（--filter 无匹配）验证失败委托
// 不回落根包：kp 必须跳过而非提取这里的 53998
export default {
  server: {
    port: 53998,
  },
}
