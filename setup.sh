#!/bin/bash
#
# CC-Manager V0 一键初始化脚本
# ================================
# 用法: bash setup.sh /path/to/your/project [workers_count]
#
# 功能:
#   1. 验证环境（git, python3, claude CLI）
#   2. 初始化 Git 仓库（如果不存在）
#   3. 创建 CLAUDE.md 和 PROGRESS.md
#   4. 安装 Python 依赖
#   5. 创建 worktree 池
#   6. 运行 Layer 0 验证
#   7. 输出就绪报告

set -e

# 颜色
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

info() { echo -e "${BLUE}[INFO]${NC} $1"; }
ok()   { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
fail() { echo -e "${RED}[✗]${NC} $1"; }

# ============================================================
# 参数
# ============================================================

REPO_PATH="${1:-.}"
WORKERS="${2:-10}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo ""
echo "========================================"
echo "   CC-Manager V0 初始化"
echo "========================================"
echo "  目标仓库: $REPO_PATH"
echo "  Workers:  $WORKERS"
echo "========================================"
echo ""

# ============================================================
# Step 1: 环境检查
# ============================================================

info "Step 1: 环境检查"

PASS=0; FAIL=0

check() {
    local name="$1" cmd="$2"
    if eval "$cmd" > /dev/null 2>&1; then
        ok "$name"
        ((PASS++))
    else
        fail "$name"
        ((FAIL++))
    fi
}

check "Git 已安装" "which git"
check "Python3 已安装" "which python3"
check "Claude CLI 已安装" "which claude"
check "Python >= 3.9" "python3 -c 'import sys; assert sys.version_info >= (3,9)'"

# 检查 claude 版本
if which claude > /dev/null 2>&1; then
    CC_VERSION=$(claude --version 2>/dev/null || echo "unknown")
    info "  Claude CLI 版本: $CC_VERSION"
fi

if [ $FAIL -gt 0 ]; then
    fail "环境检查失败 ($FAIL 项不通过)"
    exit 1
fi
ok "环境检查通过 ($PASS/$PASS)"
echo ""

# ============================================================
# Step 2: Git 仓库初始化
# ============================================================

info "Step 2: Git 仓库初始化"

REPO_PATH=$(cd "$REPO_PATH" && pwd)

if [ -d "$REPO_PATH/.git" ]; then
    ok "Git 仓库已存在: $REPO_PATH"
else
    info "初始化 Git 仓库..."
    cd "$REPO_PATH"
    git init
    git checkout -b main 2>/dev/null || true
    touch .gitkeep
    git add .gitkeep
    git commit -m "init: project setup"
    ok "Git 仓库已创建"
fi

cd "$REPO_PATH"

# 确保在 main 分支
git checkout main 2>/dev/null || git checkout -b main 2>/dev/null || true
echo ""

# ============================================================
# Step 3: 创建 CLAUDE.md
# ============================================================

info "Step 3: 创建 CLAUDE.md"

if [ ! -f "$REPO_PATH/CLAUDE.md" ]; then
cat > "$REPO_PATH/CLAUDE.md" << 'CLAUDE_EOF'
# 项目规则

## 架构
- 这是一个由 CC-Manager 管理的多 Agent 协作项目
- 每个 Agent 在独立的 Git Worktree 中工作
- 完成后自动 merge 到 main 分支

## 工作流程
1. 仔细阅读任务描述，理解需求
2. 在当前 worktree 中完成开发
3. 确保代码可以正常运行（如果适用）
4. 运行相关测试（如果有）
5. `git add` 所有相关文件
6. `git commit -m "feat: [简短描述]"`
7. 完成后正常退出

## 代码规范
- 中英文之间加半角空格
- Python 代码遵循 PEP 8
- 函数和类需要 docstring
- 不混用中英文引号（中文用中文引号，代码用英文引号）

## 禁止事项
- ❌ 不要修改其他 worktree 的文件
- ❌ 不要修改 CLAUDE.md（除非任务明确要求）
- ❌ 不要执行 `git push`（由 Manager 统一处理）
- ❌ 不要执行 `git merge`（由 Manager 统一处理）
- ❌ 不要执行破坏性操作（rm -rf, force push 等）
- ❌ 遇到冲突不要自行解决，标记失败即可

## 完成标准
- 所有要求的功能已实现
- 代码语法无误
- 已 git commit
- 无残留的调试代码
CLAUDE_EOF
    git add CLAUDE.md
    git commit -m "docs: add CLAUDE.md project rules"
    ok "CLAUDE.md 已创建"
else
    ok "CLAUDE.md 已存在"
fi

# ============================================================
# Step 4: 创建 PROGRESS.md
# ============================================================

info "Step 4: 创建 PROGRESS.md"

if [ ! -f "$REPO_PATH/PROGRESS.md" ]; then
cat > "$REPO_PATH/PROGRESS.md" << 'PROGRESS_EOF'
# 项目进展记录

> 本文件由 CC Agent 自动维护，记录经验教训和改进建议。

## 经验教训

<!-- Agent 在完成任务后将经验记录在这里 -->

## 常见错误模式

<!-- 记录反复出现的错误，供后续 Agent 参考 -->

## 改进建议

<!-- 对 CLAUDE.md 或工作流程的改进建议 -->
PROGRESS_EOF
    git add PROGRESS.md
    git commit -m "docs: add PROGRESS.md for experience tracking"
    ok "PROGRESS.md 已创建"
else
    ok "PROGRESS.md 已存在"
fi

echo ""

# ============================================================
# Step 5: 安装 Python 依赖
# ============================================================

info "Step 5: 安装 Python 依赖"

pip3 install aiohttp --break-system-packages -q 2>/dev/null || \
pip3 install aiohttp -q 2>/dev/null || \
warn "aiohttp 安装失败，请手动安装"

python3 -c "import aiohttp" 2>/dev/null && ok "aiohttp 已安装" || fail "aiohttp 未安装"
echo ""

# ============================================================
# Step 6: 创建 .gitignore
# ============================================================

info "Step 6: 配置 .gitignore"

if ! grep -q ".worktrees" "$REPO_PATH/.gitignore" 2>/dev/null; then
cat >> "$REPO_PATH/.gitignore" << 'GITIGNORE_EOF'

# CC-Manager
.worktrees/
__pycache__/
*.pyc
*.log
.cc-manager/
GITIGNORE_EOF
    git add .gitignore
    git commit -m "chore: update .gitignore for CC-Manager"
    ok ".gitignore 已更新"
else
    ok ".gitignore 已配置"
fi
echo ""

# ============================================================
# Step 7: Layer 0 快速验证
# ============================================================

info "Step 7: Layer 0 快速验证 (CC CLI 能力检查)"

# 解除嵌套限制
unset CLAUDECODE 2>/dev/null || true
unset CLAUDE_CODE_ENTRYPOINT 2>/dev/null || true

L0_PASS=0; L0_FAIL=0; L0_SKIP=0

l0_test() {
    local id="$1" desc="$2" cmd="$3" check="$4"
    echo -n "  [$id] $desc ... "
    if timeout 60 bash -c "$cmd" > /tmp/cc_l0_out 2>&1; then
        if eval "$check" > /dev/null 2>&1; then
            echo -e "${GREEN}PASS${NC}"
            ((L0_PASS++))
        else
            echo -e "${RED}FAIL (check)${NC}"
            ((L0_FAIL++))
        fi
    else
        echo -e "${YELLOW}SKIP (timeout/error)${NC}"
        ((L0_SKIP++))
    fi
}

# 基础测试（在 repo 目录内运行）
cd "$REPO_PATH"

l0_test "L0-1" "非交互模式" \
    "claude -p 'respond with exactly the word PINGOK' --print" \
    "grep -qi 'PINGOK' /tmp/cc_l0_out"

l0_test "L0-2" "stream-json输出" \
    "claude -p 'say ok' --output-format stream-json --print" \
    "head -1 /tmp/cc_l0_out | python3 -c 'import json,sys; d=json.loads(sys.stdin.read()); assert \"type\" in d'"

l0_test "L0-3" "权限跳过" \
    "claude -p 'create a file called /tmp/cc_l0_perm_test with content TEST' --dangerously-skip-permissions --print" \
    "test -f /tmp/cc_l0_perm_test"

echo ""
echo "  Layer 0 结果: PASS=$L0_PASS  FAIL=$L0_FAIL  SKIP=$L0_SKIP"

if [ $L0_PASS -ge 2 ]; then
    ok "Layer 0 验证基本通过"
elif [ $L0_SKIP -ge 2 ]; then
    warn "Layer 0 部分跳过（可能是嵌套限制，在独立终端中运行可解决）"
else
    warn "Layer 0 验证未全通过，Manager 可能无法正常工作"
fi
echo ""

# ============================================================
# 完成报告
# ============================================================

echo "========================================"
echo "   ✅ CC-Manager V0 初始化完成"
echo "========================================"
echo ""
echo "  仓库路径:  $REPO_PATH"
echo "  Workers:   $WORKERS"
echo "  CLAUDE.md: ✓"
echo "  PROGRESS.md: ✓"
echo "  Layer 0:   PASS=$L0_PASS FAIL=$L0_FAIL SKIP=$L0_SKIP"
echo ""
echo "  启动 Manager:"
echo "    python3 $SCRIPT_DIR/manager.py --repo $REPO_PATH --workers $WORKERS"
echo ""
echo "  打开浏览器:"
echo "    http://localhost:8080"
echo ""
echo "========================================"
