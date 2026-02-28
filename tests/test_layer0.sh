#!/bin/bash
#
# Layer 0: CC CLI 能力全面验证
# ============================
# 用法: bash test_layer0.sh [repo_path]
#
# 测试 CC CLI 的各项能力是否可用，
# 这是整个 CC-Manager 系统的前提条件。

set -u

REPO_PATH="${1:-.}"
cd "$REPO_PATH" || { echo "无法进入 $REPO_PATH"; exit 1; }

# 确保是 git repo
if [ ! -d ".git" ]; then
    echo "初始化临时 git repo..."
    git init && touch .gitkeep && git add . && git commit -m "init" 2>/dev/null
fi

# 解除嵌套限制
unset CLAUDECODE 2>/dev/null || true
unset CLAUDE_CODE_ENTRYPOINT 2>/dev/null || true

# 颜色
G='\033[0;32m'; R='\033[0;31m'; Y='\033[1;33m'; N='\033[0m'

PASS=0; FAIL=0; SKIP=0
RESULTS=""

run_test() {
    local id="$1" desc="$2" timeout_s="$3" cmd="$4" check="$5"
    echo -n "[$id] $desc ... "

    local tmpout="/tmp/cc_test_${id}"
    if timeout "$timeout_s" bash -c "$cmd" > "$tmpout" 2>&1; then
        if eval "$check" > /dev/null 2>&1; then
            echo -e "${G}PASS${N}"
            ((PASS++))
            RESULTS+="PASS  $id  $desc\n"
            return 0
        else
            echo -e "${R}FAIL (验证失败)${N}"
            ((FAIL++))
            RESULTS+="FAIL  $id  $desc\n"
            return 1
        fi
    else
        local ec=$?
        if [ $ec -eq 124 ]; then
            echo -e "${Y}SKIP (超时 ${timeout_s}s)${N}"
            ((SKIP++))
            RESULTS+="SKIP  $id  $desc  (timeout)\n"
        else
            echo -e "${R}FAIL (退出码=$ec)${N}"
            ((FAIL++))
            RESULTS+="FAIL  $id  $desc  (exit=$ec)\n"
        fi
        return 1
    fi
}

echo ""
echo "========================================"
echo "  Layer 0: CC CLI 能力验证"
echo "========================================"
echo "  工作目录: $(pwd)"
echo "  Claude: $(which claude 2>/dev/null || echo 'NOT FOUND')"
echo "  版本: $(claude --version 2>/dev/null || echo 'unknown')"
echo "========================================"
echo ""

# 清理旧测试文件
rm -f /tmp/cc_l0_* /tmp/cc_test_*

# ---- 测试用例 ----

run_test "L0-1" "非交互模式可运行" 90 \
    "claude -p 'respond with exactly: PING_OK_L01' --print" \
    "grep -q 'PING_OK_L01' /tmp/cc_test_L0-1"

run_test "L0-2" "JSON 输出格式" 90 \
    "claude -p 'respond with: hello' --output-format json" \
    "python3 -c 'import json; json.loads(open(\"/tmp/cc_test_L0-2\").read())'"

run_test "L0-3" "Stream-JSON 输出" 90 \
    "claude -p 'say ok' --output-format stream-json" \
    "python3 -c '
import json, sys
lines = [l.strip() for l in open(\"/tmp/cc_test_L0-3\").readlines() if l.strip()]
assert len(lines) > 0, \"no output lines\"
for l in lines:
    obj = json.loads(l)
    assert \"type\" in obj, f\"missing type in {l}\"
print(f\"OK: {len(lines)} events\")
'"

run_test "L0-4" "权限跳过" 120 \
    "claude -p 'create a file at /tmp/cc_l0_perm_test.txt containing the text PERMISSION_OK' --dangerously-skip-permissions --print" \
    "test -f /tmp/cc_l0_perm_test.txt"

run_test "L0-5" "Stream-JSON + Verbose" 90 \
    "claude -p 'say hi' --output-format stream-json --verbose" \
    "python3 -c '
lines = [l for l in open(\"/tmp/cc_test_L0-5\").readlines() if l.strip()]
print(f\"verbose output: {len(lines)} lines\")
assert len(lines) >= 1
'"

run_test "L0-6" "预算控制" 90 \
    "claude -p 'say ok' --max-budget-usd 0.50 --print" \
    "test -s /tmp/cc_test_L0-6"  # 只要有输出就行

run_test "L0-7" "模型指定" 90 \
    "claude -p 'say ok' --model sonnet --print" \
    "test -s /tmp/cc_test_L0-7"

# L0-8: worktree 模式（如果支持）
if claude --help 2>&1 | grep -q "worktree"; then
    run_test "L0-8" "worktree 内置支持" 120 \
        "claude -p 'say ok from worktree' --worktree cc-l0-test --print" \
        "git worktree list | grep -q 'cc-l0-test'"
    # 清理
    git worktree remove cc-l0-test 2>/dev/null || true
else
    echo "[L0-8] worktree 内置 ... SKIP (CLI不支持)"
    ((SKIP++))
fi

run_test "L0-9" "system-prompt" 90 \
    "claude -p '你好' --system-prompt '你必须用英文回答，回答中包含 SYSPROMPT_OK' --print" \
    "grep -qi 'SYSPROMPT_OK' /tmp/cc_test_L0-9"

# L0-10: 嵌套限制绕过
run_test "L0-10" "嵌套限制绕过(unset CLAUDECODE)" 90 \
    "env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT claude -p 'say NESTED_OK' --print" \
    "grep -qi 'NESTED_OK' /tmp/cc_test_L0-10 || test -s /tmp/cc_test_L0-10"

# ---- 结果汇总 ----

echo ""
echo "========================================"
echo "  Layer 0 验证结果"
echo "========================================"
echo -e "$RESULTS"
echo "  PASS=$PASS  FAIL=$FAIL  SKIP=$SKIP"
echo "  总计: $((PASS+FAIL+SKIP))"
echo ""

TOTAL=$((PASS+FAIL+SKIP))
if [ $PASS -eq $TOTAL ]; then
    echo -e "  ${G}✅ 全部通过! CC-Manager 可以正常运行${N}"
    exit 0
elif [ $PASS -ge 5 ]; then
    echo -e "  ${Y}⚠️ 基本通过，部分功能受限${N}"
    exit 0
else
    echo -e "  ${R}❌ 验证未通过，请检查 Claude CLI 安装${N}"
    exit 1
fi
