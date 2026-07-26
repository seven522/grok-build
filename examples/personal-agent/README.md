# RunBuild MVP

This example keeps the Agent runtime independent from any model vendor. It
ships with MiMo as the default profile because the local `uni` project already
uses it, but the active model is selected entirely in configuration.

## Isolated configuration

Use a dedicated runtime directory so this experiment does not alter an
existing Grok configuration:

```sh
export GROK_HOME="$PWD/.personal-grok"
mkdir -p "$GROK_HOME"
cp examples/personal-agent/models.toml.example "$GROK_HOME/config.toml"
```

## Credentials

Provide provider credentials only through the process environment. Do not copy
keys into `config.toml` or commit them:

```sh
export MIMO_API_KEY='...'
export DEEPSEEK_API_KEY='...'
```

If the `uni` project is the credential owner, load its environment using its
existing local workflow, then start this program from this repository.

## Select or add a model

Set `[models].default` to one of the named `[model.<profile>]` entries in
`config.toml`. The catalog provides examples for:

- MiMo and any OpenAI-compatible Chat Completions endpoint
- DeepSeek V4 Pro through its OpenAI-compatible Chat Completions endpoint
- OpenAI-compatible Responses API endpoints
- Anthropic Messages API endpoints

For a provider with a private or incompatible wire protocol, place an adapter
or gateway in front of it and expose one of these three protocols. The Agent
runtime, tool permissions, sessions, and prompts remain unchanged.

## First acceptance check

After building the binary, run a read-only prompt first:

```sh
cargo run -p xai-grok-pager-bin -- -p "Read the current repository structure and summarize it. Do not modify files or run shell commands."
```

Success means the request reaches MiMo, returns a coherent answer, and leaves
the repository unchanged. Only then enable write or terminal workflows.

## Daily start

From the repository root, start RunBuild with:

```sh
./run agent
```

Start DeepSeek V4 Pro directly with:

```sh
./run agent deepseek
```

For an analysis-only session, use:

```sh
./run read-only
```
