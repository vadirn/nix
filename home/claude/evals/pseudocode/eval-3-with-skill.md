## Deploy flow

```
sha = Bash(git rev-parse HEAD)
Bash(docker build -t app:<sha> .)

// Guards
env = Bash(echo $TARGET_ENV)
if env not in ["staging", "production"]: stop("TARGET_ENV must be 'staging' or 'production'")
if env == "production": AskUserQuestion("Confirm production deployment with SHA <sha>?")

// Push image
Bash(docker tag app:<sha> <ecr_repo>:latest)
Bash(docker tag app:<sha> <ecr_repo>:<sha>)
Bash(aws ecr get-login-password | docker login --username AWS --password-stdin <ecr_repo>)
Bash(docker push <ecr_repo>:<sha>)
Bash(docker push <ecr_repo>:latest)

// Update ECS
prev_task_def = Bash(aws ecs describe-services --cluster <cluster> --services <service> --query 'services[0].taskDefinition')
new_task_def = do("register new task definition with image <ecr_repo>:<sha>")
Bash(aws ecs update-service --cluster <cluster> --service <service> --task-definition <new_task_def>)

// Wait for stabilization
stable = Bash(aws ecs wait services-stable --cluster <cluster> --services <service>)  // timeout 10min, poll 30s
if not stable: Bash(aws ecs update-service --cluster <cluster> --service <service> --task-definition <prev_task_def>)
status = if stable: "success" else: "rollback"
if not stable: do("tell user what went wrong, include service events")

// Log
do("append line to deploy.log: <timestamp> <env> <sha> <status>")
```

## Reference

### Environment variable

- `TARGET_ENV` must be set to `staging` or `production` before running
- Production requires explicit user confirmation; staging does not

### ECR + ECS

- `<ecr_repo>`: full ECR repository URI (e.g. `123456789.dkr.ecr.us-east-1.amazonaws.com/app`)
- `<cluster>` and `<service>`: ECS cluster and service names
- `aws ecs wait services-stable` polls every 30s, times out after 10 minutes by default

### Rollback

- On stabilization failure, revert to previous task definition (`prev_task_def`)
- Surface ECS service events so user can diagnose the failure

### Deploy log

- File: `deploy.log` in working directory
- Format: `<ISO-8601 timestamp> <env> <sha> <status>`
- Status is `success` or `rollback`
