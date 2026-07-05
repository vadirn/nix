
Running continuous integration on modern multi-core developer machines is faster and eliminates the complexity of remote CI infrastructure.

**Remote CI setup** traditionally relies on external servers to validate code changes, often taking around five and a half minutes per run. Those servers introduce a network hop, credential management, and scheduling overhead that act as **bridges of complexity**, slowing feedback loops and demanding dedicated maintenance.

A **developer machine** equipped with high-core CPUs such as Intel 14900K or Apple M3 Max can execute the same checks locally. Its abundant cores provide the raw horsepower needed to run many tasks at once without leaving the workstation.

When that hardware is harnessed for **parallelized work**, each test, lint, or build step can occupy its own core, collapsing what once required sequential minutes into seconds of wall-clock time. This concurrency is the engine that makes local CI competitive with, and often superior to, its remote counterpart.

Adopting a **simplified stack** means stripping away the remote orchestration layer and letting the powerful developer machine run the pipeline directly. By doing so, the **bridges of complexity** inherent in the remote CI setup disappear, leaving a lean, fast, and maintainable workflow.

## Workflow

1. Adopt a no-build approach because modern browsers now have fast JavaScript and CSS engines. [Let's go #nobuild](https://world.hey.com/dhh/once-1-is-entirely-nobuild-for-the-front-end-ce56f6d7)
2. Run continuous integration on local developer machines because developer CPUs now have dozens of cores. [Let's pull CI home](https://gist.github.com/dhh/c5051aae633ff91bc4ce30528e4f0b60)
3. Stop using gotcha-hinged accelerators such as Spring because single-core performance has risen dramatically. [Let's drop gotcha-hinged accelerators like Spring](https://x.com/dhh/status/1783291561402577279)
4. As always, the simplified future is not evenly distributed.

## Glossary

| Term                  | Definition                                                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| remote CI setup       | A BuildKite-based continuous integration system running on remote servers that validates code changes in about 5m30s.         |
| developer machine     | A high-core local computer (e.g., Intel 14900K, M3 Max) executing checks and tests faster than remote CI.                     |
| parallelized work     | Concurrent execution of many checks across multiple CPU cores, enabled by machines with 8-20 cores.                           |
| simplified stack      | A development environment stripped of remote CI complexity, favoring local execution on powerful developer CPUs.              |
| bridges of complexity | Metaphorical obstacles representing remote continuous-integration components that should be eliminated for simpler workflows. |

## Relations

- simplified-stack contrast-to:: remote-ci-setup
