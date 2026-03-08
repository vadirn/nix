---
name: deploy
description: Build, push, and deploy a Docker container to ECS. Use when the user wants to deploy to staging or production.
---

# Deploy

Builds a Docker image, pushes to ECR, updates ECS, waits for stabilization. Rolls back on failure.

## Process

```
sha = git rev-parse --short HEAD
image = docker build -t app:{sha} .

env = $TARGET_ENV
if env not in ["staging", "production"] → abort("TARGET_ENV must be 'staging' or 'production'")
if env == "production" → ask user to confirm, abort if declined

docker tag app:{sha} {ecr_url}:latest
docker tag app:{sha} {ecr_url}:{sha}
docker push {ecr_url}:latest
docker push {ecr_url}:{sha}

prev_task_def = aws ecs describe-services → current task definition ARN
new_task_def = aws ecs register-task-definition with new image
aws ecs update-service --task-definition {new_task_def}

# Wait for stabilization
elapsed = 0
loop every 30s, timeout 600s:
  status = aws ecs describe-services → deployment status
  if stable → break
  if elapsed >= 600 → fail

if failed:
  aws ecs update-service --task-definition {prev_task_def}
  tell user what went wrong
  log_deployment(env, sha, "FAILED")
  abort

log_deployment(env, sha, "SUCCESS")
```

## log_deployment

```
append to deploy.log:
  "{timestamp} | {env} | {sha} | {status}"
```
