# llama.cpp-qwen4exp

这是 [ggml-org/llama.cpp](https://github.com/ggml-org/llama.cpp) 的一个个人分支：以最新的上游 `master`（`60b06ab9`，2026-09-19）为基线，叠加我们长期在生产环境里实际使用的一小组补丁。上游的全部文档、构建说明仍然适用，见 [docs/build.md](docs/build.md) 与上游 [README](https://github.com/ggml-org/llama.cpp/blob/master/README.md)。

## 我们在本地真实跑出的速度

以下数字全部来自我们生产部署的 `llama-server` 运行日志（同一套补丁思路的引擎，之前落在稍早的上游基线上；本仓库已把其中尚未被上游吸收的部分重放到最新 master，方向一致或更优，未逐条重新对拍）。

测量机器：**RTX 5060 Ti 16GB** + EPYC 7B12（64 核 128 线程，最高 2.25 GHz，仅 AVX2）+ 256GB 内存。

运行权重（也是我们唯一常跑的一款）：**Qwen3.8-Flash-Next（qwen4exp 架构）Q4_K_XL 量化**，约 177B 总参数的 MoE（512 专家、激活 10 个），权重约 111GB，专家权重放在 CPU 侧（`--cpu-moe`，mmap 惰性读取），配一个约 2GB 的 MTP draft 侧车权重和 Q8_0 的多模态投影，上下文 262144，KV 缓存 q4_0 量化，单并发。

decode 吐字速度（稳态均值，按已用上下文长度分档）：

| 已用上下文 | decode |
|---|---|
| < 8K | 60 - 73 t/s |
| 8K - 16K | ~34 t/s |
| 24K - 32K | ~29 t/s |
| 40K - 48K | ~26 t/s |
| 72K - 80K | ~20 t/s |
| 120K - 128K | ~17 t/s |

- prefill：52 - 68 t/s（多轮对话利用前缀缓存，每轮通常只增量 prefill 几百到几千 token）
- MTP 投机解码：草稿 token 接受率约 67%，平均每步产出约 2.3 个 token

在这台 16GB 显存的机器上，没有这些补丁（CPU-MoE 快路径、MTP 链路修复、长上下文稀疏注意力、状态序列化瘦身等），同一份权重跑不出上面的曲线。

## 局限性

- **为单一模型调优**：MTP 共享侧车加载、PLE、长上下文稀疏注意力、CPU-MoE 单 token 快路径等都只针对 Qwen3.8-Flash-Next（qwen4exp）架构；其他模型能照常运行，但不会得到额外收益。
- **我们只用这一款权重**：README 中的速度与验证都以上面那份 Q4_K_XL + MTP 侧车为准，我们没有为其他量化档或衍生权重做系统调参。
- **吃内存**：该权重（约 111GB）把专家放在 CPU 侧 mmap 惰性读取，实测稳态常驻内存约 95GB（无 swap）。建议备 128GB 级系统内存 + 16GB 级显存跑上述配置；再小的内存我们没有实测过，不保证可用。
- **稀疏注意力只在长上下文生效**：低于 top-k 预算时自动回退 dense 路径，短上下文场景看不到收益。
- **CUDA 侧重较新架构**：补丁在 sm_120（Blackwell）+ CUDA 13.2 上验证；其他 CUDA 版本按上游支持矩阵编译运行，未逐一实测。
- **单并发长上下文是主场景**：批量、多并发不是我们的使用方式，未做专门优化与验证。
- 个人分支，不承诺同步频率；补丁被上游吸收后会直接删除。

## 本仓库叠加的补丁

基线快照之后的每个 commit 是一条独立补丁，git 顺序即应用顺序：

1. **qwen4exp 模型支持（基础层）** - 模型定义与 HF 转换、PLE n-gram 嵌入、GDN 层、mmap 惰性加载、可借用目标模型 embedding/LM head 的 MTP draft 侧车。
2. **MMQ ids 越界防护** - 修专家数很多的 MoE 模型在大 ubatch 下的非法显存访问，使 `-ub 512` 及以上安全。
3. **Web UI 数学渲染修复** - 单行 `$$...$$` 不再渲染成红色错误文本，未闭合的 `$$` 自动补全；自托管 dist 下去掉无意义的更新弹窗。
4. **投机解码回滚截断** - 修复越过结束符的草稿 token 回滚位置错误导致吞掉最终回答。
5. **MTP 载体置零** - 清除跨请求泄漏的陈旧隐状态，消除新会话开头的不确定性重复。
6. **llama-bench 支持 --override-kv** - 不用重新转换 GGUF 就能做超参/量化档 A/B。
7. **概率化草稿采样 + 拒绝采样验证** - 按 min(1, p/q) 接受草稿，保持目标模型输出分布；`--spec-draft-sampling probabilistic` 启用。
8. **PARTIAL_ONLY 状态序列化** - 每轮上下文检查点不再整体搬运目标 KV + 草稿 KV，长上下文首字延迟大幅下降。
9. **复用后端调度器** - 每请求的 `llama_set_sampler()` 不再推倒重建全部 compute buffer 与固定输入缓冲（大上下文下每请求约省 0.5 秒以上）。
10. **qwen4exp 启用稀疏 FA** - 把 QSA indexer 的 top-k 作为稀疏 KV 预算喂给 MMA f16 flash-attention 内核；预算内保持 dense。
11. **tiny-N matmul 走 mmvf** - decode 批量下 HC 注入/门控与 GDN 的小矩阵乘从 cuBLAS 改为 mmvf，略快且少一次 kernel。
12. **mul_mat_id 单 token 快路径** - CPU-MoE 专家流上去掉共享行缓冲、栅栏与伪共享。
13. **IQ*_S 在 sm_120 上的加载修复** - 绕开 nvcc 13.2 对打包字节提取的误编译，IQ 量化权重在 Blackwell 上不再输出乱码。

## 快速开始

```bash
git clone <本仓库> && cd llama.cpp-qwen4exp
./scripts/build.sh            # 需要 cmake（建议 >= 3.25）与 CUDA toolkit
./build/bin/llama-server --version
```

跑 qwen4exp 权重时需要：主权重 + `--cpu-moe` + MTP 侧车（`-md` 配 `--spec-type draft-mtp`）+ `--flash-attn on`，其余参数按上游 server 文档来。

## 建仓目的

主要是为我们自己，也为将来可能在云主机上借到各种 CUDA 版本 GPU 的人提前储备一个"拿来就能编"的引擎：`git clone` 之后执行一条 `./scripts/build.sh`，对着当时机器上的任意 CUDA 版本编一个二进制即可运行，不需要去找、去试、去编译任何第三方发行版。
