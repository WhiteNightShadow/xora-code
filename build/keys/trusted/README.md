# 受信任的应用包公钥

shell只加载签名能被这里的公钥（以及开发构建里的本机开发公钥）验证通过的应用包。

- 每个公钥一个文件，命名为`<keyId>.pub`，内容是spki格式的pem。这里只放公钥，私钥永远不进仓库（`.gitignore`已忽略`.keys/`和`*.pem`）。
- 正式发布前（M6）需要离线生成发布密钥，把公钥放到这里；ci用`XORA_SIGNING_KEY_FILE`指向私钥签名，并设`XORA_RELEASE=1`，这样安装包里就不会信任开发公钥。
- 开发构建会自动生成`.keys/dev-signing.pem`，只在本机使用。
