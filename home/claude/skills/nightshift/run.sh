#!/usr/bin/env bash
# Nightshift: autonomous Claude Code runner
#
# Usage:
#   ./run.sh --workspace ~/projects/myapp
#   ./run.sh --workspace . --model claude-opus-4-6[1m] --wait 60
#   ./run.sh --workspace . --dockerfile ./Dockerfile.claude
#
# Setup (one-time):
#   SKILL_DIR=$(cd "$(dirname "$0")" && pwd)
#   docker build -t claude-runner "$SKILL_DIR"
#   docker volume create claude-runner-home
#   docker run --rm -it -v claude-runner-home:/home/claude claude-runner bash -c "claude /login"
#
# Stop: Ctrl+C to stop after the current iteration finishes.

set -uo pipefail

WORKSPACE=""
ITERATIONS=100
WAIT=300
MODEL="claude-opus-4-6[1m]"
DOCKER_IMAGE="claude-runner"
DOCKER_VOLUME="claude-runner-home"
DOCKERFILE=""
CONTAINER_NAME="nightshift-$$"
STOPPED=false

cleanup() {
    STOPPED=true
    echo ""
    echo "nightshift: stopping after current iteration (Ctrl+C again to force)"
    trap 'docker kill "$CONTAINER_NAME" 2>/dev/null; exit 130' INT TERM
}
trap cleanup INT TERM

while [ $# -gt 0 ]; do
    case "$1" in
        --workspace)     WORKSPACE="$2"; shift 2 ;;
        --iterations)    ITERATIONS="$2"; shift 2 ;;
        --wait)          WAIT="$2"; shift 2 ;;
        --model)         MODEL="$2"; shift 2 ;;
        --docker-image)  DOCKER_IMAGE="$2"; shift 2 ;;
        --docker-volume) DOCKER_VOLUME="$2"; shift 2 ;;
        --dockerfile)    DOCKERFILE="$2"; shift 2 ;;
        *)
            echo "Unknown option: $1" >&2
            echo "Usage: $0 --workspace DIR [--iterations N] [--wait SECONDS] [--model MODEL] [--dockerfile PATH]" >&2
            exit 1
            ;;
    esac
done

if [ -z "$WORKSPACE" ]; then
    echo "error: --workspace is required" >&2
    exit 1
fi

WORKSPACE=$(cd "$WORKSPACE" && pwd)

if [ ! -f "$WORKSPACE/project.md" ]; then
    echo "error: project.md not found in $WORKSPACE" >&2
    exit 1
fi

# Build project-specific image if --dockerfile provided
RUN_IMAGE="$DOCKER_IMAGE"
if [ -n "$DOCKERFILE" ]; then
    if [ ! -f "$DOCKERFILE" ]; then
        echo "error: dockerfile not found at $DOCKERFILE" >&2
        exit 1
    fi
    HASH=$(md5sum "$DOCKERFILE" | cut -c1-8)
    RUN_IMAGE="claude-runner-${HASH}"
    echo "nightshift: building project image $RUN_IMAGE from $DOCKERFILE"
    docker build -t "$RUN_IMAGE" -f "$DOCKERFILE" "$(dirname "$DOCKERFILE")"
fi

touch "$WORKSPACE/progress.txt"

echo "nightshift: up to $ITERATIONS iterations, ${WAIT}s between, model=$MODEL"
echo "nightshift: workspace=$WORKSPACE"
echo "nightshift: image=$RUN_IMAGE"
echo "nightshift: Ctrl+C to stop gracefully"
echo ""

for i in $(seq 1 "$ITERATIONS"); do
    if [ "$STOPPED" = true ]; then
        echo "nightshift: stopped by user after iteration $((i - 1))"
        break
    fi

    echo "=== iteration $i/$ITERATIONS ==="

    PROMPT="You are running as an autonomous agent in iteration $i of $ITERATIONS.

Read project.md for the task specification.
Read progress.txt for what previous iterations accomplished.

Instructions:
- If progress.txt is empty, start from the beginning.
- Otherwise, continue from where the last iteration left off.
- Work on one task at a time. Commit after completing each task.
- Before finishing, append a summary to progress.txt: what you did, what remains.
- If blocked on something, document it in progress.txt and move to the next task.
- When ALL tasks in project.md are complete, write NIGHTSHIFT_COMPLETE as the last line of progress.txt.

Work autonomously. Do not ask questions."

    docker run --rm \
        --name "$CONTAINER_NAME" \
        -v "$DOCKER_VOLUME:/home/claude" \
        -v "$WORKSPACE:/workspace" \
        "$RUN_IMAGE" \
        -p "$PROMPT" \
        --dangerously-skip-permissions \
        --model "$MODEL"

    EXIT_CODE=$?

    echo ""
    echo "=== iteration $i complete (exit=$EXIT_CODE) ==="

    if [ -f "$WORKSPACE/progress.txt" ]; then
        echo "--- progress ---"
        tail -20 "$WORKSPACE/progress.txt"
        echo "--- end ---"

        if tail -1 "$WORKSPACE/progress.txt" | grep -q "NIGHTSHIFT_COMPLETE"; then
            echo ""
            echo "nightshift: all tasks complete"
            break
        fi
    fi
    echo ""

    if [ "$i" -lt "$ITERATIONS" ] && [ "$STOPPED" = false ]; then
        echo "nightshift: waiting ${WAIT}s before next iteration (Ctrl+C to stop)"
        sleep "$WAIT" &
        wait $! 2>/dev/null
    fi
done

echo "nightshift: finished after $i iterations"
