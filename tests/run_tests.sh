#!/bin/bash
#
# CC-Manager 测试运行器
# =====================
# 用法:
#   bash run_tests.sh           # 运行所有测试
#   bash run_tests.sh layer0    # 只运行 Layer 0
#   bash run_tests.sh layer1    # 只运行 Layer 1
#   bash run_tests.sh layer2    # 只运行 Layer 2
#   bash run_tests.sh quick     # 快速模式（只 Layer 1 单元测试）
#
# 依赖: pytest, pytest-asyncio

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# 颜色
G='\033[0;32m'; R='\033[0;31m'; Y='\033[1;33m'; B='\033[0;34m'; N='\033[0m'

echo ""
echo -e "${B}========================================${N}"
echo -e "${B}  CC-Manager 自动化测试${N}"
echo -e "${B}========================================${N}"
echo "  项目目录: $PROJECT_DIR"
echo "  Python: $(python3 --version 2>&1)"
echo ""

# 安装测试依赖
install_deps() {
    echo -e "${B}[SETUP]${N} 安装测试依赖..."
    pip3 install pytest pytest-asyncio aiohttp --break-system-packages -q 2>/dev/null || \
    pip3 install pytest pytest-asyncio aiohttp -q 2>/dev/null
    echo ""
}

# Layer 0: CC CLI 能力验证（bash）
run_layer0() {
    echo -e "${B}━━━ Layer 0: CC CLI 能力验证 ━━━${N}"
    if [ -f "$SCRIPT_DIR/test_layer0.sh" ]; then
        bash "$SCRIPT_DIR/test_layer0.sh" "$PROJECT_DIR"
    else
        echo -e "${Y}[SKIP]${N} test_layer0.sh 不存在"
    fi
    echo ""
}

# Layer 1: 单元测试（pytest）
run_layer1() {
    echo -e "${B}━━━ Layer 1: 单元测试 ━━━${N}"
    cd "$PROJECT_DIR"
    python3 -m pytest tests/test_layer1_*.py -v --tb=short -x 2>&1
    local rc=$?
    if [ $rc -eq 0 ]; then
        echo -e "${G}Layer 1 全部通过${N}"
    else
        echo -e "${R}Layer 1 有失败 (exit=$rc)${N}"
    fi
    echo ""
    return $rc
}

# Layer 2: 集成测试（pytest）
run_layer2() {
    echo -e "${B}━━━ Layer 2: 集成测试 ━━━${N}"
    cd "$PROJECT_DIR"
    python3 -m pytest tests/test_layer2_*.py -v --tb=short -x 2>&1
    local rc=$?
    if [ $rc -eq 0 ]; then
        echo -e "${G}Layer 2 全部通过${N}"
    else
        echo -e "${R}Layer 2 有失败 (exit=$rc)${N}"
    fi
    echo ""
    return $rc
}

# 全部测试
run_all() {
    install_deps

    L1_RC=0; L2_RC=0

    run_layer1 || L1_RC=$?
    run_layer2 || L2_RC=$?

    echo -e "${B}========================================${N}"
    echo -e "${B}  测试结果汇总${N}"
    echo -e "${B}========================================${N}"

    if [ $L1_RC -eq 0 ]; then
        echo -e "  Layer 1 (单元测试):   ${G}PASS${N}"
    else
        echo -e "  Layer 1 (单元测试):   ${R}FAIL${N}"
    fi

    if [ $L2_RC -eq 0 ]; then
        echo -e "  Layer 2 (集成测试):   ${G}PASS${N}"
    else
        echo -e "  Layer 2 (集成测试):   ${R}FAIL${N}"
    fi

    echo ""

    if [ $L1_RC -eq 0 ] && [ $L2_RC -eq 0 ]; then
        echo -e "  ${G}✅ 所有测试通过! Agent Ready!${N}"
        exit 0
    else
        echo -e "  ${R}❌ 部分测试失败${N}"
        exit 1
    fi
}

# 解析参数
MODE="${1:-all}"

case "$MODE" in
    layer0)
        run_layer0
        ;;
    layer1)
        install_deps
        run_layer1
        ;;
    layer2)
        install_deps
        run_layer2
        ;;
    quick)
        install_deps
        run_layer1
        ;;
    all)
        run_all
        ;;
    *)
        echo "用法: $0 [layer0|layer1|layer2|quick|all]"
        exit 1
        ;;
esac
