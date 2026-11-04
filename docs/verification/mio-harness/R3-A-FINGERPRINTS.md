# R3-A 请求指纹逐条核对

基线：main `49d74189`。三个协议各 29 条普通请求仅加载器的 names 枚举新增 `mioon_project_media_list`、maxItems 91→92；每条 +27 UTF-8 字节。12 条诊断原字节不变。将两处恢复旧值后，普通请求完整字符串也与基线严格相等，未改正文、顺序、工具结果、限制或序列化。R3-A 不提前发布 R3-B 的导入工具。

每行是实际网关捕获的一条请求；`index` 从 1 起。完整 SHA256 核对和路径列在机器记录中。

| 协议 | 场景 | index | bytes 前→后 | SHA256 前→后 | 原因 |
| --- | --- | --- | --- | --- | --- |
| chat_completions | single_reply | 1 | 24329→24356 | `732fa298b962`→`6929c6e0a1b3` | 加载器 names +1 / maxItems +1 |
| chat_completions | read_edit_roundtrip | 1 | 24360→24387 | `dcfc78c808bb`→`191987ee853e` | 加载器 names +1 / maxItems +1 |
| chat_completions | read_edit_roundtrip | 2 | 26633→26660 | `6d076f50e399`→`14897670f14d` | 加载器 names +1 / maxItems +1 |
| chat_completions | read_edit_roundtrip | 3 | 27090→27117 | `e7cc0b52fff5`→`61868321d6be` | 加载器 names +1 / maxItems +1 |
| chat_completions | read_edit_roundtrip | 4 | 27844→27871 | `283901bac7aa`→`77f5207945b2` | 加载器 names +1 / maxItems +1 |
| chat_completions | note_during_reply | 1 | 24329→24356 | `732fa298b962`→`6929c6e0a1b3` | 加载器 names +1 / maxItems +1 |
| chat_completions | note_during_reply | 2 | 24435→24462 | `f4e2c15c219b`→`87add0906705` | 加载器 names +1 / maxItems +1 |
| chat_completions | conflict_reread | 1 | 24329→24356 | `732fa298b962`→`6929c6e0a1b3` | 加载器 names +1 / maxItems +1 |
| chat_completions | conflict_reread | 2 | 26602→26629 | `57d1522f36d5`→`5668f501bef2` | 加载器 names +1 / maxItems +1 |
| chat_completions | conflict_reread | 3 | 27774→27801 | `8110087c2076`→`b66f2bf664b3` | 加载器 names +1 / maxItems +1 |
| chat_completions | conflict_reread | 4 | 28551→28578 | `973210f95008`→`0d4bbc313686` | 加载器 names +1 / maxItems +1 |
| chat_completions | tool_failure_retry | 1 | 24329→24356 | `732fa298b962`→`6929c6e0a1b3` | 加载器 names +1 / maxItems +1 |
| chat_completions | tool_failure_retry | 2 | 26602→26629 | `57d1522f36d5`→`5668f501bef2` | 加载器 names +1 / maxItems +1 |
| chat_completions | tool_failure_retry | 3 | 27042→27069 | `a8e0e4c4d1e6`→`8017ab15c2d8` | 加载器 names +1 / maxItems +1 |
| chat_completions | tool_failure_retry | 4 | 27797→27824 | `81500d118759`→`617762cc13fd` | 加载器 names +1 / maxItems +1 |
| chat_completions | unknown_discard_resume | 1 | 24329→24356 | `732fa298b962`→`6929c6e0a1b3` | 加载器 names +1 / maxItems +1 |
| chat_completions | unknown_discard_resume | 2 | 24508→24535 | `3ba89332dc32`→`9581c9c1a399` | 加载器 names +1 / maxItems +1 |
| chat_completions | conversation_history_trim | 1 | 52322→52349 | `98ad993b727a`→`0fad9a2fa5ea` | 加载器 names +1 / maxItems +1 |
| chat_completions | conversation_history_trim | 2 | 130818→130845 | `7a25f708237e`→`f9c70c6d57b7` | 加载器 names +1 / maxItems +1 |
| chat_completions | conversation_history_trim | 3 | 102832→102859 | `a07e99180c0f`→`b386899b891e` | 加载器 names +1 / maxItems +1 |
| chat_completions | attachment_en | 1 | 26953→26980 | `d0134991b063`→`db050d6e8257` | 加载器 names +1 / maxItems +1 |
| chat_completions | diagnostic_text | 1 | 1000→1000 | `cc3417e13ab9`→`cc3417e13ab9` | 诊断：逐字节不变 |
| chat_completions | diagnostic_read_only | 1 | 55023→55023 | `75bf2aa30a89`→`75bf2aa30a89` | 诊断：逐字节不变 |
| chat_completions | diagnostic_read_only | 2 | 55493→55493 | `1b0cae92e759`→`1b0cae92e759` | 诊断：逐字节不变 |
| chat_completions | diagnostic_catalog | 1 | 2980→2980 | `3a0df35bf156`→`3a0df35bf156` | 诊断：逐字节不变 |
| chat_completions | single_reply_ja | 1 | 27940→27967 | `1b04092864bb`→`6091476c21eb` | 加载器 names +1 / maxItems +1 |
| chat_completions | single_reply_en | 1 | 25278→25305 | `49f8596310be`→`95401f8fa580` | 加载器 names +1 / maxItems +1 |
| chat_completions | single_reply_zh_hant | 1 | 24401→24428 | `5e319f7b7aa1`→`e9bd37b61bc3` | 加载器 names +1 / maxItems +1 |
| responses | single_reply | 1 | 24104→24131 | `81a978424fbd`→`1be21482b9d0` | 加载器 names +1 / maxItems +1 |
| responses | read_edit_roundtrip | 1 | 24135→24162 | `1d5cfccda3cf`→`caf67d5b1e2d` | 加载器 names +1 / maxItems +1 |
| responses | read_edit_roundtrip | 2 | 26478→26505 | `fadcbe30f956`→`0558e591dd13` | 加载器 names +1 / maxItems +1 |
| responses | read_edit_roundtrip | 3 | 27018→27045 | `758ce138dcb5`→`e19f0e01a9a5` | 加载器 names +1 / maxItems +1 |
| responses | read_edit_roundtrip | 4 | 27855→27882 | `635ea81c8d98`→`89d7d8382e06` | 加载器 names +1 / maxItems +1 |
| responses | note_during_reply | 1 | 24104→24131 | `81a978424fbd`→`1be21482b9d0` | 加载器 names +1 / maxItems +1 |
| responses | note_during_reply | 2 | 24280→24307 | `f61ca7f97a27`→`497ea05e7a63` | 加载器 names +1 / maxItems +1 |
| responses | conflict_reread | 1 | 24104→24131 | `81a978424fbd`→`1be21482b9d0` | 加载器 names +1 / maxItems +1 |
| responses | conflict_reread | 2 | 26447→26474 | `3be9285b5770`→`1ca3ed28ae1d` | 加载器 names +1 / maxItems +1 |
| responses | conflict_reread | 3 | 27702→27729 | `58652006c6ba`→`7612314f3db5` | 加载器 names +1 / maxItems +1 |
| responses | conflict_reread | 4 | 28562→28589 | `be09488cac31`→`c73864708e72` | 加载器 names +1 / maxItems +1 |
| responses | tool_failure_retry | 1 | 24104→24131 | `81a978424fbd`→`1be21482b9d0` | 加载器 names +1 / maxItems +1 |
| responses | tool_failure_retry | 2 | 26447→26474 | `3be9285b5770`→`1ca3ed28ae1d` | 加载器 names +1 / maxItems +1 |
| responses | tool_failure_retry | 3 | 26970→26997 | `56f87a104ed5`→`94bd7534baa7` | 加载器 names +1 / maxItems +1 |
| responses | tool_failure_retry | 4 | 27808→27835 | `7f7b9e446b0e`→`c93f9b446721` | 加载器 names +1 / maxItems +1 |
| responses | unknown_discard_resume | 1 | 24104→24131 | `81a978424fbd`→`1be21482b9d0` | 加载器 names +1 / maxItems +1 |
| responses | unknown_discard_resume | 2 | 24283→24310 | `da94a37cf1a3`→`36806180b64e` | 加载器 names +1 / maxItems +1 |
| responses | conversation_history_trim | 1 | 52097→52124 | `3c7616ccca55`→`611be01e2773` | 加载器 names +1 / maxItems +1 |
| responses | conversation_history_trim | 2 | 130593→130620 | `7beb239aef7a`→`e29b1375ad58` | 加载器 names +1 / maxItems +1 |
| responses | conversation_history_trim | 3 | 102607→102634 | `03b03a1484ad`→`ac8963553a5b` | 加载器 names +1 / maxItems +1 |
| responses | attachment_en | 1 | 26702→26729 | `b3eab133ae4f`→`ca1c71a09888` | 加载器 names +1 / maxItems +1 |
| responses | diagnostic_text | 1 | 1009→1009 | `7ac9288df536`→`7ac9288df536` | 诊断：逐字节不变 |
| responses | diagnostic_read_only | 1 | 54304→54304 | `87d727d06e6f`→`87d727d06e6f` | 诊断：逐字节不变 |
| responses | diagnostic_read_only | 2 | 54857→54857 | `de77bfff8b39`→`de77bfff8b39` | 诊断：逐字节不变 |
| responses | diagnostic_catalog | 1 | 2976→2976 | `d267fa680a4e`→`d267fa680a4e` | 诊断：逐字节不变 |
| responses | single_reply_ja | 1 | 27715→27742 | `c82b1ab62ac6`→`d44c67096915` | 加载器 names +1 / maxItems +1 |
| responses | single_reply_en | 1 | 25053→25080 | `0c67af689af9`→`fe561989e12f` | 加载器 names +1 / maxItems +1 |
| responses | single_reply_zh_hant | 1 | 24176→24203 | `8548a4ad4e7d`→`9ff0abcc033e` | 加载器 names +1 / maxItems +1 |
| anthropic_messages | single_reply | 1 | 23857→23884 | `50578cfeb8f2`→`c78f4451871c` | 加载器 names +1 / maxItems +1 |
| anthropic_messages | read_edit_roundtrip | 1 | 23888→23915 | `76ec4e03d3c5`→`b040b784daa2` | 加载器 names +1 / maxItems +1 |
| anthropic_messages | read_edit_roundtrip | 2 | 26153→26180 | `a1e024106486`→`ebf42de16cb0` | 加载器 names +1 / maxItems +1 |
| anthropic_messages | read_edit_roundtrip | 3 | 26635→26662 | `af2a5670b18c`→`51f4785968ed` | 加载器 names +1 / maxItems +1 |
| anthropic_messages | read_edit_roundtrip | 4 | 27402→27429 | `745b7b14a852`→`d1f6d02349bb` | 加载器 names +1 / maxItems +1 |
| anthropic_messages | note_during_reply | 1 | 23857→23884 | `50578cfeb8f2`→`c78f4451871c` | 加载器 names +1 / maxItems +1 |
| anthropic_messages | note_during_reply | 2 | 23988→24015 | `f8b23217cd65`→`f4ca6f58b4f6` | 加载器 names +1 / maxItems +1 |
| anthropic_messages | conflict_reread | 1 | 23857→23884 | `50578cfeb8f2`→`c78f4451871c` | 加载器 names +1 / maxItems +1 |
| anthropic_messages | conflict_reread | 2 | 26122→26149 | `9c47823dfc33`→`e9e76d33e85c` | 加载器 names +1 / maxItems +1 |
| anthropic_messages | conflict_reread | 3 | 27307→27334 | `cce4713e40f0`→`c593c96e355c` | 加载器 names +1 / maxItems +1 |
| anthropic_messages | conflict_reread | 4 | 28097→28124 | `16a6218556c2`→`1e27f783ba34` | 加载器 names +1 / maxItems +1 |
| anthropic_messages | tool_failure_retry | 1 | 23857→23884 | `50578cfeb8f2`→`c78f4451871c` | 加载器 names +1 / maxItems +1 |
| anthropic_messages | tool_failure_retry | 2 | 26122→26149 | `9c47823dfc33`→`e9e76d33e85c` | 加载器 names +1 / maxItems +1 |
| anthropic_messages | tool_failure_retry | 3 | 26577→26604 | `ce4dff94df8b`→`dd9de3dd8824` | 加载器 names +1 / maxItems +1 |
| anthropic_messages | tool_failure_retry | 4 | 27345→27372 | `1285567e1365`→`7ff7ad04d9f0` | 加载器 names +1 / maxItems +1 |
| anthropic_messages | unknown_discard_resume | 1 | 23857→23884 | `50578cfeb8f2`→`c78f4451871c` | 加载器 names +1 / maxItems +1 |
| anthropic_messages | unknown_discard_resume | 2 | 24036→24063 | `adff2f7be95c`→`ae8816b5d3c5` | 加载器 names +1 / maxItems +1 |
| anthropic_messages | conversation_history_trim | 1 | 51850→51877 | `ab5a08d10bee`→`7e22ee6ba6b8` | 加载器 names +1 / maxItems +1 |
| anthropic_messages | conversation_history_trim | 2 | 130346→130373 | `2d36196303f0`→`318f4d1c6340` | 加载器 names +1 / maxItems +1 |
| anthropic_messages | conversation_history_trim | 3 | 102360→102387 | `92bd3eaa1ee1`→`33972223da23` | 加载器 names +1 / maxItems +1 |
| anthropic_messages | attachment_en | 1 | 26423→26450 | `b5ba110ec55d`→`08491f6c59a6` | 加载器 names +1 / maxItems +1 |
| anthropic_messages | diagnostic_text | 1 | 986→986 | `87a91bb251da`→`87a91bb251da` | 诊断：逐字节不变 |
| anthropic_messages | diagnostic_read_only | 1 | 53448→53448 | `5fd201b29fe3`→`5fd201b29fe3` | 诊断：逐字节不变 |
| anthropic_messages | diagnostic_read_only | 2 | 53943→53943 | `94b02a08e19b`→`94b02a08e19b` | 诊断：逐字节不变 |
| anthropic_messages | diagnostic_catalog | 1 | 3000→3000 | `8e61706e848b`→`8e61706e848b` | 诊断：逐字节不变 |
| anthropic_messages | single_reply_ja | 1 | 27468→27495 | `65af1533c73b`→`8ec3c884e16e` | 加载器 names +1 / maxItems +1 |
| anthropic_messages | single_reply_en | 1 | 24806→24833 | `9e9083f712a9`→`21377b453370` | 加载器 names +1 / maxItems +1 |
| anthropic_messages | single_reply_zh_hant | 1 | 23929→23956 | `7a91f66e8b2a`→`b12d58f87581` | 加载器 names +1 / maxItems +1 |
| chat_completions | official_single_reply | 1 | 24690→24717 | `43f189b816cb`→`6c40ac63e61d` | 加载器 names +1 / maxItems +1 |
| chat_completions | official_read_edit_roundtrip | 1 | 24721→24748 | `b4181b1d691b`→`7a15bd8aa40f` | 加载器 names +1 / maxItems +1 |
| chat_completions | official_read_edit_roundtrip | 2 | 27009→27036 | `b09802dee9c3`→`f2855b56baad` | 加载器 names +1 / maxItems +1 |
| chat_completions | official_read_edit_roundtrip | 3 | 27466→27493 | `3d5dd1e6bbf2`→`906941915032` | 加载器 names +1 / maxItems +1 |
| chat_completions | official_read_edit_roundtrip | 4 | 28220→28247 | `1dd582240497`→`7d32379dd0fa` | 加载器 names +1 / maxItems +1 |
| responses | official_single_reply | 1 | 24420→24447 | `d40095b06790`→`8adbdbbfc865` | 加载器 names +1 / maxItems +1 |
| responses | official_read_edit_roundtrip | 1 | 24451→24478 | `cfdd04f5cf27`→`c6a36e5103a1` | 加载器 names +1 / maxItems +1 |
| responses | official_read_edit_roundtrip | 2 | 26809→26836 | `f6f5a33cbb39`→`db595ae6ff58` | 加载器 names +1 / maxItems +1 |
| responses | official_read_edit_roundtrip | 3 | 27349→27376 | `ac8397bb5a8d`→`876bc1cf4bf0` | 加载器 names +1 / maxItems +1 |
| responses | official_read_edit_roundtrip | 4 | 28186→28213 | `30d292bec3f3`→`53c0c2b597bd` | 加载器 names +1 / maxItems +1 |
| anthropic_messages | official_single_reply | 1 | 24027→24054 | `de5ebf513e39`→`8fd619726bac` | 加载器 names +1 / maxItems +1 |
| anthropic_messages | official_read_edit_roundtrip | 1 | 24058→24085 | `9ff088f1ac70`→`3799cd8b1b56` | 加载器 names +1 / maxItems +1 |
| anthropic_messages | official_read_edit_roundtrip | 2 | 26335→26362 | `746d35f4005f`→`c4338c550566` | 加载器 names +1 / maxItems +1 |
| anthropic_messages | official_read_edit_roundtrip | 3 | 26817→26844 | `1ee257c13ba4`→`921e5d4ac747` | 加载器 names +1 / maxItems +1 |
| anthropic_messages | official_read_edit_roundtrip | 4 | 27584→27611 | `561f1e0fb92e`→`7129d5f6ecd0` | 加载器 names +1 / maxItems +1 |

完整 SHA256 与逐请求 JSON 路径：[R3-A-FINGERPRINTS.json](R3-A-FINGERPRINTS.json)。
