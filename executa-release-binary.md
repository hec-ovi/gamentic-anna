# Don't Just Run Locally: A Hands-on Guide to Packaging Anna Executa as a Releasable Binary

In the previous beginner tutorial (From Zero to Your First Anna App: A Hands-On Beginner’s Guide), we walked through the official `anna-app-llm-demo`: starting Anna App, opening the UI, calling the platform LLM, and seeing another interesting path: instead of the frontend calling `anna.llm.complete(...)` directly, it invokes reverse-RPC through an Executa Tool and lets the host complete the LLM call.

However, the previous article mainly answered one question: how does this App run, and why can it run?

There is another question closer to real-world distribution that we did not expand on at the time:

**If I have written an Executa Tool, do users also need to install Python, install uv, pull the source code, and then use it?**

Of course not.

For formal distribution, the recommended approach is to package the Executa as a binary file. This way, users do not need to care about the Python environment, manually install dependencies, or understand your source directory structure. Anna Agent will automatically select the binary package for the current system, download it, extract it, start it, and communicate with it through the standard stdio JSON-RPC protocol.

This tutorial fills in the part that the previous article did not cover in detail. We will use this Executa from the official repository as the example:

```
examples/anna-app-llm-demo/executas/llm-via-executa-python
```

Step by step, we will turn it from a locally runnable Python Executa into a binary distribution package that can be placed in a GitHub Release, written into `binary_urls`, and installed by Anna Agent.

If the goal of the previous tutorial was “first get Anna App running”, then the goal of this one is: **let your Executa leave your development machine and become a Tool that can truly be published and installed.**

## Chapter 1: First Understand the Goal: What Exactly Are We Packaging as a Binary?

Before we start typing packaging commands, let’s not rush to install PyInstaller.

Many binary packaging tutorials begin by telling you to run:

```bash
pyinstaller --onefile ...
```

But if you have not yet figured out “what this command is supposed to package”, “who will download the packaged file”, and “where Anna Agent will learn about this file”, the rest of the workflow easily turns into blind copying.

Copying can certainly get you through one run temporarily. But once you change a `tool_id`, switch platforms, or mistype a file name in GitHub Release, it becomes hard to tell whether the problem is in building, packaging, uploading, or `executa.json`.

So in this first chapter, we will clarify the goal.

### The Object We Are Packaging This Time

This tutorial packages the following Executa from the official example:

```
examples/anna-app-llm-demo/executas/llm-via-executa-python
```

After entering this directory, you will see several key files:

```
llm-via-executa-python/
├── README.md
├── executa.json
├── llm_via_executa_plugin.py
├── pyproject.toml
└── uv.lock
```

The most important ones are these three:

* `llm_via_executa_plugin.py`: the actual Executa Tool implementation. It handles JSON-RPC requests and calls host sampling from inside the tool.
* `pyproject.toml`: the Python project configuration. It declares the project name, version, dependencies, and command-line entry point.
* `executa.json`: the Executa metadata read by Anna development tools. It contains the `tool_id`, the runtime type used during development, and the distribution configuration used for publishing.

In other words, we are not packaging the entire `anna-app-llm-demo`, and we are not packaging the frontend page. This tutorial focuses on one goal only: package the Python Executa Tool `llm-via-executa-python` as a binary file.

### How Does It Run During Local Development?

During local development, this Executa is not started by the user double-clicking it, nor is it imported directly by the frontend.

When you run the local development command in the `examples/anna-app-llm-demo` directory, `anna-app dev` scans the project’s `executas/` directory. It finds:

```
executas/llm-via-executa-python/executa.json
```

Then it registers this Python Executa into the local development harness based on that file’s configuration. When the frontend invokes the tool, the host starts and calls it through stdio JSON-RPC.

The rough flow can be understood like this:

```
Anna App UI
  │
  │ anna.tools.invoke(...)
  ▼
Anna host / local dev harness
  │
  │ stdio JSON-RPC
  ▼
llm-via-executa-python
  │
  │ sampling/createMessage
  ▼
Host LLM
```

There is a crucial point here: this Executa is still an independent process. Anna host communicates with it through stdio JSON-RPC, rather than importing it directly as a Python function.

This is also why it can be packaged as a binary. As long as the packaged file can still read stdin, write stdout, and implement the same JSON-RPC protocol after startup, Anna Agent does not care whether it was originally written in Python, Node.js, Go, or another language.

### Why Not Stop at Local Running?

The local running mode is suitable for developers, but not for final distribution.

A developer’s machine can have Python, `uv`, the source directory, and can tolerate installing dependencies on the first run. But when real users install a Tool, they expect a different experience:

1. Click install
2. Wait for download
3. Start using it

They should not need to know:
* whether this Tool is written in Python;
* which Python version should be installed;
* whether `uv` exists locally;
* whether dependencies are installed completely;
* whether the current shell’s `PATH` is configured correctly.

If we package the Executa as a binary, these problems can be solved ahead of time during publishing. Anna Agent on the user’s machine only needs to do one thing: download the binary package for the current platform, then start the executable inside it.

This is the value of binary distribution.

### What Does the Final Packaged Output Look Like?

After packaging, what we ultimately want is not “an executable file placed somewhere locally”, but a set of distribution packages that Anna Agent can download, recognize, extract, and start.

For this example, the final artifacts usually look like this:

```
tool-test-llm-via-executa-12345678-darwin-arm64.tar.gz
tool-test-llm-via-executa-12345678-darwin-x86_64.tar.gz
tool-test-llm-via-executa-12345678-linux-x86_64.tar.gz
```

These file names contain two types of information:

* `tool-test-llm-via-executa-12345678`: the placeholder `tool_id` used by the current example. For real publishing, you should replace it with the official `tool_id` minted on the Anna platform.
* `darwin-arm64`, `darwin-x86_64`, `linux-x86_64`: platform keys that tell Anna Agent which operating system and CPU architecture the package is for.

Note that `.tar.gz` is not the “final program to run” itself, but a distribution package. After Anna Agent downloads it, it first extracts it, then finds the actual entry file to start inside it.

For the simplest PyInstaller `--onefile` scenario, the archive contains at least one executable file:

```
tool-test-llm-via-executa-12345678-darwin-arm64.tar.gz
└── tool-test-llm-via-executa-12345678
```

But this is only the minimal form. A more standard and recommended form is to also place a `manifest.json` in the archive, explicitly declaring the package’s entry file and runtime information:

```
tool-test-llm-via-executa-12345678-darwin-arm64.tar.gz
├── tool-test-llm-via-executa-12345678
└── manifest.json
```

The benefit is that the Agent does not need to guess “which file is the entry point”. Instead, it can directly find the file to start based on the manifest or the `entrypoint` in `binary_urls`.

If your Executa later becomes more than a single file and needs extra dynamic libraries, data files, model files, or sub-tools, the archive may become structured like this:

```
my-tool-darwin-arm64.tar.gz
├── bin/
│   └── my-tool
├── lib/
│   └── ...
├── data/
│   └── ...
└── manifest.json
```

This is multi-file binary distribution. It uses the same installation mechanism as a single-file binary, but the package contains more content and `manifest.json` becomes more important.

This tutorial starts with the easiest-to-understand single-file PyInstaller packaging: first turn the Python Executa into an executable file that can start independently, then put it into `.tar.gz`, and finally make the `binary_urls` in `executa.json` point to these distribution packages. We can cover the details of multi-file packaging separately later.

### Why Is tool_id So Important?

You may have noticed that the same string appears everywhere in this example:

```
tool-test-llm-via-executa-12345678
```

It appears in `executa.json`, and also in the project name and script entry in `pyproject.toml`. This value is the placeholder `tool_id` used by the example.

For real publishing, `tool_id` is not something you can name casually. It should come from Anna platform’s mint flow and is the stable identity assigned to this Executa by the platform.

Why be so strict? Because Anna uses this ID to connect several things:
* which Tool the App manifest declares as a dependency;
* which Tool the frontend specifies when calling `anna.tools.invoke(...)`;
* which tool directory the Agent places files into during installation;
* how later version updates know this is a new version of the same Executa.

So before real publishing, you need to replace the placeholder ID in the example with your own official `tool_id`. But in order to learn the packaging flow first, we can continue using the example placeholder in the first few chapters, then discuss replacement after understanding the full process.

### Chapter Summary

So far, we have not run any packaging commands. This is intentional.

Before starting the build, remember these three sentences:
1. We are not packaging the entire Anna App, but the Python Executa Tool `llm-via-executa-python`.
2. The target packaged artifacts are platform-specific `.tar.gz` files containing executables that Anna Agent can start.
3. The `binary_urls` in `executa.json` connect the platform, download URL, entrypoint, and related information.

In the next chapter, we will start the actual preparation work: confirm the local environment, enter the example directory, check the `tool_id` and Python entry point, and first use development mode to confirm this Executa works normally before packaging.

## Chapter 2: Get Your Own Playground First: Fork the Official Example Repository

In the previous beginner tutorial, we directly used `anna-app-llm-demo` from the official example repository. This is great for learning: the code is already written, the directory structure is complete, and the configuration is visible, so you can clone it and run it directly.

But this tutorial is not only about local running. Later, we will do something closer to real publishing: use GitHub Actions to automatically package Executa binaries and upload the artifacts to GitHub Release.

At that point, you cannot only look at the official repository.

The reason is simple: you do not have permission to run the release workflow in the official repository. You cannot freely modify its workflow, and you cannot upload your own binary files into its Releases. Even if you can build a binary locally, when you later fill in `binary_urls`, they should point to your own Release download URLs, not URLs in the official example repository.

So before formally entering packaging, we first do one preparation step: copy the official example repository into your own practice repository.

### Why Must You Have Your Own Repository?

If you only want to read the code, or only want to try PyInstaller locally, cloning the official repository is enough:

```bash
git clone https://github.com/whtcjdtc2007/anna-executa-examples.git
```

But if you want to complete this tutorial end to end, especially the later steps:
* modify `executa.json`;
* replace the placeholder `tool_id` in the example;
* run GitHub Actions;
* create a GitHub Release;
* upload `.tar.gz` binary artifacts;
* make `binary_urls` point to your own download URLs;

then you need a repository where you have write permission.

This repository can be a fork, or it can be a new repository that you manually copied. For most readers, the simplest approach is to fork the official example repository.

### Fork the Official Example Repository

Open the official example repository:

```
https://github.com/whtcjdtc2007/anna-executa-examples
```

Click Fork in the upper-right corner of the page.
GitHub will create a copy under your account. The URL usually becomes:

```
https://github.com/<your-github-username>/anna-executa-examples
```

The GitHub Actions we run later, the Release we create, and the binary files we upload will all happen in this repository that belongs to you.

Please note: from this chapter onward, “your repository” in the tutorial refers to the forked repository, not the original official repository.

### Clone Your Own Repository

After forking, clone your own repository locally:

```bash
git clone https://github.com/<your-github-username>/anna-executa-examples.git
cd anna-executa-examples
```

Replace `<your-github-username>` with your GitHub username.

If you have already cloned the official repository, it is also recommended to clone your forked repository again this time, so you do not accidentally operate on a remote where you do not have write permission later.

You can confirm where the current repository points with this command:

```bash
git remote -v
```

You should see output similar to:

```
origin  https://github.com/<your-github-username>/anna-executa-examples.git (fetch)
origin  https://github.com/<your-github-username>/anna-executa-examples.git (push)
```

If it is still:

```
https://github.com/whtcjdtc2007/anna-executa-examples.git
```

then your current directory is still connected to the official repository. You can continue reading and running locally, but you will not be able to upload build artifacts to your own GitHub Release.

### Enter the Executa Directory We Will Package

Next, enter the main directory for this tutorial:

```bash
cd examples/anna-app-llm-demo/executas/llm-via-executa-python
```

You should see these files in the directory:

```
README.md
executa.json
llm_via_executa_plugin.py
pyproject.toml
uv.lock
```

Among them:
* `llm_via_executa_plugin.py` is the Python Executa implementation we will package later;
* `pyproject.toml` determines the Python project name, dependencies, and command-line entry point;
* `executa.json` determines this Executa’s metadata in Anna development tools and the publishing flow;
* `uv.lock` locks dependency versions, helping local development and CI use the same dependency environment.

We will not modify them yet in this chapter. For now, just confirm that you are in the correct directory.

### Confirm That GitHub Actions Can Run

Because we will use GitHub Actions to package binaries later, you also need to confirm that Actions is enabled in the forked repository.

Open your GitHub repository page and go to the Actions tab.

If GitHub prompts you to enable workflows, click to enable them. Forked repositories sometimes pause Actions by default. This is normal; manually enabling them once is enough.

Later, we will use the repository’s workflow to perform multi-platform builds. You do not need to run it right now. Just confirm that the Actions tab can open normally and that you have write permission for this repository.

### Chapter Summary

At this point, we have completed the most important repository preparation before packaging:
* you have your own `anna-executa-examples` repository;
* the local clone’s remote points to your own GitHub account;
* you know that this tutorial packages `llm-via-executa-python`;
* you know that the later Release assets and `binary_urls` should point to your own repository;
* GitHub Actions can already run in your repository.

We did not change any code or start packaging in this chapter. This is intentional.

Before building binaries, we need to confirm one thing first: this Executa is already healthy in source mode. If it cannot run in source mode, packaging will only hide the problem more deeply.

In the next chapter, we will do the pre-packaging “inspection”: start `llm-via-executa-python` locally first and confirm it can respond normally to describe, health, and tool calls.

## Chapter 3: Find the Real `tool_id` and Organize Local Configuration Before Packaging

In the previous chapter, we forked the official example repository and learned that we will later use our own GitHub Actions and GitHub Release to package binaries.

In this chapter, we will not rush into packaging. We first need to solve a more critical problem:

**What exactly is this Executa’s official `tool_id`?**

This matters because the later binary file name, PyInstaller output name, Tool configuration on the Anna platform, and entrypoint in `binary_urls` will all revolve around this `tool_id`.

If you use the wrong value here, even if the binary is packaged successfully later, the platform may not be able to find the correct tool.

### If You Pushed the App Following the Previous Tutorial, the Platform Has Already Created the Tool for You

In the previous beginner tutorial, if you already ran something like:

```bash
anna-app apps push
```

or pushed `anna-app-llm-demo` to the platform through the Anna App publishing flow, then the platform will automatically create a corresponding Tool based on the bundled Executa configuration in the App.

In other words, you do not need to invent a `tool_id` from scratch.

You need to find it on the platform.

Open the App you just pushed on the Anna platform and enter the relevant advanced configuration page:

```
More -> Advanced -> Executa
```

There you can see the Executa Tool bound to this App. After clicking into it, you will see a Tool configuration page.

In the example shown in the screenshots, the Tool ID generated by the platform is:

```
tool-youming-llm-via-executa-yv49p6ce
```

This is the example `tool_id` used later in this tutorial.

But note: when you follow along, you will definitely see your own ID, perhaps like this:

```
tool-<your-handle>-llm-via-executa-xxxxxxxx
```

Everywhere later that shows `tool-youming-llm-via-executa-yv49p6ce` should be replaced with the Tool ID you see on your own platform page.

### Why Can’t We Keep Using the Placeholder in the Example?

The official repository’s example defaults to a placeholder ID:

```
tool-test-llm-via-executa-12345678
```

This ID is convenient for a local demo because it is stable, easy to recognize, and not tied to a real account.

But for real packaging and publishing, it is not suitable.

The reason is that the Anna platform identifies a Tool by the `tool_id` actually created by the platform, which is the ID you see on the Tool configuration page. For example, in this tutorial:

```
tool-youming-llm-via-executa-yv49p6ce
```

The binaries we package later will also be named with this ID:

```
tool-youming-llm-via-executa-yv49p6ce-darwin-arm64.tar.gz
tool-youming-llm-via-executa-yv49p6ce-linux-x86_64.tar.gz
```

The benefit is very direct: the Tool ID on the platform, binary file name, entrypoint, and CI build artifacts all match.

### Which Places Need to Be Changed?

Enter the Executa directory:

```bash
cd examples/anna-app-llm-demo/executas/llm-via-executa-python
```

This chapter mainly focuses on two files:
* `executa.json`
* `pyproject.toml`

First, the key point: you do not need to configure distribution in `executa.json` right now.

That means `binary_urls`, GitHub Release URLs, entrypoint, platform download URLs, and related content will be configured later directly on the Anna platform. The current local file only needs to keep development and publishing metadata.

#### Modify `executa.json`

Open:

```
examples/anna-app-llm-demo/executas/llm-via-executa-python/executa.json
```

You can first organize the key fields into this shape:

```json
{
  "slug": "llm-via-executa",
  "name": "LLM via Executa",
  "version": "0.1.0",
  "executa_type": "tool",
  "description": "Exposes a `complete` tool that wraps host sampling/createMessage via reverse-RPC, letting the LLM Demo app run completions through an Executa instead of calling anna.llm.complete directly.",
  "tool_id": "tool-youming-llm-via-executa-yv49p6ce",
  "type": "python",
  "enabled": true
}
```

The most important line is:

```json
  "tool_id": "tool-youming-llm-via-executa-yv49p6ce"
```

You need to replace it with the Tool ID you see on your own platform.

Do not worry about these fields for now:

```json
"distribution": {
  ...
}
```

If your file already has distribution, you can ignore it for now; to make the tutorial clearer, you can also temporarily delete it. When we truly configure binary download URLs later, we will fill them in on the platform’s Tool configuration page rather than hand-writing them here.

This point is important: later in this tutorial, we will configure binary distribution through the platform UI. You are not required to maintain `binary_urls` in `executa.json`.

#### Modify `pyproject.toml`

Next, open:

```
pyproject.toml
```

You will see something like:

```toml
[project]
name = "tool-test-llm-via-executa-12345678"

[project.scripts]
"tool-test-llm-via-executa-12345678" = "llm_via_executa_plugin:main"
```

Replace the placeholder inside with your real Tool ID.

Using the Tool ID from the screenshots in this tutorial as the example, change it to:

```toml
[project]
name = "tool-youming-llm-via-executa-yv49p6ce"

[project.scripts]
"tool-youming-llm-via-executa-yv49p6ce" = "llm_via_executa_plugin:main"
```

Do not change the right-hand side:

```toml
llm_via_executa_plugin:main
```

It means the Python startup entry remains: `llm_via_executa_plugin.py` inside: `main()`.

We are only changing the command name and project name to the platform’s real `tool_id`.

#### Do We Need to Change the App Manifest?

In this demo, the App manifest uses a bundled handle:

```json
{
  "tool_id": "bundled:llm-via-executa"
}
```

This does not need to be changed to the real `tool_id`.

The reason is that `bundled:llm-via-executa` is the App’s internal handle for referring to this bundled Executa. During publishing, the Anna platform maps this handle to the real Tool ID.

So do not manually change it to:

```
tool-youming-llm-via-executa-yv49p6ce
```

Keep it as it is.

#### Do We Need to Change the Tool ID in the Frontend?

The current demo frontend uses the generated:

```
bundle/anna-tool-ids.js
```

to map the bundled handle to the real Tool ID.

You may see something like:

```javascript
window.__ANNA_TOOL_IDS__ = {
  "llm-via-executa": "tool-youming-llm-via-executa-yv49p6ce"
};
```

This file is usually generated by `anna-app apps publish` / the related publishing flow, and it is not recommended to maintain it manually.

So in this chapter, you also do not need to manually edit the frontend code. We only need to ensure that the Executa’s own configuration and Python project entry have been changed to the real Tool ID.

#### Update the Lock File

Because we changed the project name in `pyproject.toml`, it is recommended to synchronize the Python project again:

```bash
uv sync
```

If `uv` says the lock file needs to be updated, you can also run:

```bash
uv lock
```

There is no need to manually edit `uv.lock`. Let `uv` update it.

### Run a Local Check Before Packaging

Now you can use the Anna CLI to check whether this Executa can still start normally.

Run this in the current directory:

```bash
anna-app executa dev --describe
```

This command starts the current Executa and sends a JSON-RPC `describe` request.

If everything is normal, you should see it return manifest information. Focus on confirming:
* the command can start normally;
* there is no Python import error;
* the output includes tools;
* the process does not exit immediately.

Then check health:

```bash
anna-app executa dev --health
```

If it returns health status normally, then after changing `tool_id` and the Python entry point, source mode is still runnable.

The core goal of this chapter is to confirm:
* `describe` can run;
* `health` can run;
* the Python entry point is not broken;
* the real `tool_id` has been replaced in the local Executa configuration.

### Chapter Summary

In this chapter, we completed the most important pre-packaging step: replacing the example placeholder ID with the real Tool ID created by the platform.

We did several things:
* found the real `tool_id` on the Anna platform through More -> Advanced -> Executa;
* used `tool-youming-llm-via-executa-yv49p6ce` as the demonstration ID in this tutorial;
* modified the `tool_id` in `executa.json`;
* modified `[project].name` and `[project.scripts]` in `pyproject.toml`;
* clarified that you do not need to configure distribution in `executa.json` right now;
* clarified that `bundled:llm-via-executa` in `manifest.json` does not need to be manually replaced;
* used `anna-app executa dev --describe` and `--health` for a pre-packaging check.

In the next chapter, we can officially start packaging: use PyInstaller to turn this Python Executa into a binary file that can start independently.

## Chapter 4: Start Packaging: Use a Script to Generate a Binary Archive Anna Agent Can Install

Now we have confirmed two things:
* the `tool_id` in `executa.json` has been changed to the ID actually created by the platform;
* this Executa can normally `describe` / `health` in source mode.

Now we can finally start packaging.

The goal of this chapter is not to generate a lonely executable file, but to generate a binary distribution package that Anna Agent can install.

In other words, the final file we want looks like this:

```
dist-anna/
└── tool-youming-llm-via-executa-yv49p6ce-darwin-arm64.tar.gz
```

And inside this `.tar.gz`, there should be a more standard structure:

```
tool-youming-llm-via-executa-yv49p6ce-darwin-arm64.tar.gz
├── bin/
│   └── tool-youming-llm-via-executa-yv49p6ce
└── manifest.json
```

The `bin/` directory contains the actual binary to start, and `manifest.json` tells Anna Agent where the entry file is, what the version is, and which files need execute permission.

### First Clarify: PyInstaller Cannot Truly Cross-Compile

Before writing the script, let’s clarify a common misconception.

Later, we will indeed support these platforms:
* `darwin-arm64`
* `darwin-x86_64`
* `linux-x86_64`

But Python’s PyInstaller usually cannot produce binaries for all platforms directly on a single machine.

That means:
* an Apple Silicon Mac produces `darwin-arm64`;
* an Intel Mac produces `darwin-x86_64`;
* a Linux x86_64 runner produces `linux-x86_64`.

So the script in this chapter does two things:
1. automatically detect the current platform;
2. generate a `.tar.gz` for the corresponding platform using the official platform key.

Later, in the GitHub Actions chapter, we will let different runners run the same script separately, so we can automatically obtain multi-platform artifacts.

### Create the Packaging Script

Operate in this directory:

```bash
cd examples/anna-app-llm-demo/executas/llm-via-executa-python
```

Create a script `package_binary.sh` with the following content:

```bash
#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

EXECUTA_JSON="executa.json"
ENTRY_FILE="llm_via_executa_plugin.py"
OUT_DIR="dist-anna"

if [ ! -f "$EXECUTA_JSON" ]; then
  echo "ERROR: $EXECUTA_JSON not found" >&2
  exit 1
fi

if [ ! -f "$ENTRY_FILE" ]; then
  echo "ERROR: $ENTRY_FILE not found" >&2
  exit 1
fi

if ! command -v uv >/dev/null 2>&1; then
  echo "ERROR: uv is required. Please install uv first." >&2
  exit 1
fi

TOOL_ID="$(python3 - <<'PY'
import json
with open("executa.json", "r", encoding="utf-8") as f:
    data = json.load(f)
print(data["tool_id"])
PY
)"

VERSION="$(python3 - <<'PY'
import json
with open("executa.json", "r", encoding="utf-8") as f:
    data = json.load(f)
print(data.get("version") or "0.0.0")
PY
)"

DISPLAY_NAME="$(python3 - <<'PY'
import json
with open("executa.json", "r", encoding="utf-8") as f:
    data = json.load(f)
print(data.get("name") or data["tool_id"])
PY
)"

DESCRIPTION="$(python3 - <<'PY'
import json
with open("executa.json", "r", encoding="utf-8") as f:
    data = json.load(f)
print(data.get("description") or "")
PY
)"

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$ARCH" in
  x86_64|amd64)
    ARCH="x86_64"
    ;;
  arm64|aarch64)
    ARCH="arm64"
    ;;
esac

case "$OS-$ARCH" in
  darwin-arm64)
    PLATFORM="darwin-arm64"
    ;;
  darwin-x86_64)
    PLATFORM="darwin-x86_64"
    ;;
  linux-x86_64)
    PLATFORM="linux-x86_64"
    ;;
  *)
    echo "ERROR: unsupported platform: $OS-$ARCH" >&2
    echo "This tutorial script currently targets: darwin-arm64, darwin-x86_64, linux-x86_64" >&2
    exit 1
    ;;
esac

echo "Tool ID:  $TOOL_ID"
echo "Version:  $VERSION"
echo "Platform: $PLATFORM"
echo

rm -rf build dist "$OUT_DIR/staging-$PLATFORM"
mkdir -p "$OUT_DIR/staging-$PLATFORM/bin"

echo "==> Building single-file executable with PyInstaller"

uv run --with pyinstaller python -m PyInstaller \
  --onefile \
  --clean \
  --noupx \
  --name "$TOOL_ID" \
  "$ENTRY_FILE"

BINARY="dist/$TOOL_ID"

if [ ! -f "$BINARY" ]; then
  echo "ERROR: PyInstaller did not produce $BINARY" >&2
  exit 1
fi

if [ "$(uname -s)" = "Darwin" ]; then
  codesign --force --sign - "$BINARY" 2>/dev/null || true
fi

STAGE="$OUT_DIR/staging-$PLATFORM"
cp "$BINARY" "$STAGE/bin/$TOOL_ID"
chmod 0755 "$STAGE/bin/$TOOL_ID"

echo "==> Writing archive manifest"

python3 - "$STAGE/manifest.json" "$TOOL_ID" "$VERSION" "$DISPLAY_NAME" "$DESCRIPTION" <<'PY'
import json
import sys
from pathlib import Path

manifest_path = Path(sys.argv[1])
tool_id = sys.argv[2]
version = sys.argv[3]
display_name = sys.argv[4]
description = sys.argv[5]

entrypoint = f"bin/{tool_id}"

manifest = {
    "name": tool_id,
    "display_name": display_name,
    "version": version,
    "description": description,
    "runtime": {
        "binary": {
            "entrypoint": {
                "default": entrypoint
            },
            "permissions": {
                entrypoint: "0o755"
            }
        }
    }
}

manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
PY

ARCHIVE="$OUT_DIR/$TOOL_ID-$PLATFORM.tar.gz"

echo "==> Creating archive: $ARCHIVE"

(
  cd "$STAGE"
  tar czf "../$TOOL_ID-$PLATFORM.tar.gz" .
)

if command -v shasum >/dev/null 2>&1; then
  SHA256="$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
else
  SHA256="$(sha256sum "$ARCHIVE" | awk '{print $1}')"
fi

SIZE="$(wc -c < "$ARCHIVE" | tr -d ' ')"

echo
echo "Built archive:"
echo "  $ARCHIVE"
echo
echo "SHA-256:"
echo "  $SHA256"
echo
echo "Size:"
echo "  $SIZE bytes"
echo
echo "Archive layout:"
tar tzf "$ARCHIVE"
echo
echo "Later, the platform binary asset for this platform will look like:"
echo
cat <<JSON
"$PLATFORM": {
  "url": "https://github.com/<your-github-username>/anna-executa-examples/releases/download/llm-via-executa-v$VERSION/$TOOL_ID-$PLATFORM.tar.gz",
  "sha256": "$SHA256",
  "size": $SIZE,
  "entrypoint": "bin/$TOOL_ID",
  "format": "tar.gz"
}
JSON
```

Then give the script execute permission:

```bash
chmod +x package_binary.sh
```

### What Does This Script Do?

This script looks a bit long, but the logic is not complicated.

It mainly does six things.

First, it reads metadata from `executa.json`:
* `tool_id`
* `version`
* `name`
* `description`

This way, we do not need to hard-code `tool-youming-llm-via-executa-yv49p6ce` in the script. If your real `tool_id` is different, as long as you changed `executa.json` in the previous chapter, the script will automatically use your ID.

Second, it detects the current platform:
* `darwin-arm64`
* `darwin-x86_64`
* `linux-x86_64`

These names are the platform keys used by Anna binary distribution. Later, the same keys will be used when configuring platform download URLs.

Third, it uses PyInstaller to build a single-file binary:

```bash
uv run --with pyinstaller python -m PyInstaller \
  --onefile \
  --clean \
  --noupx \
  --name "$TOOL_ID" \
  "$ENTRY_FILE"
```

The output file name is the `tool_id`.
For example, this tutorial generates:

```
dist/tool-youming-llm-via-executa-yv49p6ce
```

Fourth, it organizes the output into Anna’s recommended archive layout:

```
dist-anna/staging-darwin-arm64/
├── bin/
│   └── tool-youming-llm-via-executa-yv49p6ce
└── manifest.json
```

The binary is not placed directly at the archive root, but inside `bin/`.

This structure is clearer and closer to the recommended format for official multi-file binaries. If you later need to add `lib/`, `data/`, or other files, you can extend it naturally.

Fifth, it generates `manifest.json` inside the archive:

```json
{
  "name": "tool-youming-llm-via-executa-yv49p6ce",
  "display_name": "LLM via Executa",
  "version": "0.1.0",
  "description": "...",
  "runtime": {
    "binary": {
      "entrypoint": {
        "default": "bin/tool-youming-llm-via-executa-yv49p6ce"
      },
      "permissions": {
        "bin/tool-youming-llm-via-executa-yv49p6ce": "0o755"
      }
    }
  }
}
```

The purpose of this file is to tell Anna Agent:

Start `bin/tool-youming-llm-via-executa-yv49p6ce` instead of making the Agent guess which file in the archive is the entry point.

Sixth, it generates `.tar.gz` and outputs:
* `sha256`
* `size`
* `entrypoint`
* `format`

These values will be used later when configuring binary distribution on the platform.

### Run the Packaging Script

Now run:

```bash
./package_binary.sh
```

If you run it on an Intel Mac, you will see something like:

```
> ./package_binary.sh                                                     **(base) **
Tool ID:  tool-youming-llm-via-executa-yv49p6ce
Version:  0.1.0
Platform: darwin-x86_64

==> Building single-file executable with PyInstaller
Installed **6 packages** in 56ms
223 INFO: PyInstaller: 6.21.0, contrib hooks: 2026.6
223 INFO: Python: 3.11.15
239 INFO: Platform: macOS-26.5.1-x86_64-i386-64bit

......

8028 INFO: Build complete! The results are available in: examples/anna-app-llm-demo/executas/llm-via-executa-python/dist
==> Writing archive manifest
==> Creating archive: dist-anna/tool-youming-llm-via-executa-yv49p6ce-darwin-x86_64.tar.gz

Built archive:
  dist-anna/tool-youming-llm-via-executa-yv49p6ce-darwin-x86_64.tar.gz

SHA-256:
  07ca7822e8cc95c995ce8c33c33bd791cf0e4cb8533653fc64a36751e4f8d299

Size:
  9917196 bytes

Archive layout:
./
./bin/
./manifest.json
./bin/tool-youming-llm-via-executa-yv49p6ce

Later, the platform binary asset for this platform will look like:

"darwin-x86_64": {
  "url": "https://github.com/<your-github-username>/anna-executa-examples/releases/download/llm-via-executa-v0.1.0/tool-youming-llm-via-executa-yv49p6ce-darwin-x86_64.tar.gz",
  "sha256": "07ca7822e8cc95c995ce8c33c33bd791cf0e4cb8533653fc64a36751e4f8d299",
  "size": 9917196,
  "entrypoint": "bin/tool-youming-llm-via-executa-yv49p6ce",
  "format": "tar.gz"
}
```

If you run it on Linux x86_64, the artifact becomes:

```
dist-anna/tool-youming-llm-via-executa-yv49p6ce-linux-x86_64.tar.gz
```

If you run it on an Apple Silicon Mac, the artifact becomes:

```
dist-anna/tool-youming-llm-via-executa-yv49p6ce-darwin-arm64.tar.gz
```

### Check the Archive Structure

The script automatically prints the archive layout at the end. You can also check it manually:

```bash
tar tzf dist-anna/tool-youming-llm-via-executa-yv49p6ce-darwin-x86_64.tar.gz
```

You should see something like:

```
./
./bin/
./bin/tool-youming-llm-via-executa-yv49p6ce
./manifest.json
```

This means the archive was not produced arbitrarily. It is a distribution package that the Anna binary installer can understand.

### Extract and Test Locally

To confirm that the binary inside the archive can really start, temporarily extract it into a directory:

```bash
mkdir -p /tmp/llm-via-executa-test
tar xzf dist-anna/tool-youming-llm-via-executa-yv49p6ce-darwin-x86_64.tar.gz -C /tmp/llm-via-executa-test
```

Remember to replace the file name with the one actually generated for your current platform.

Then send a JSON-RPC request directly to the binary:

```bash
printf '%s\n' '{"jsonrpc":"2.0","method":"describe","id":1}' \
  | /tmp/llm-via-executa-test/bin/tool-youming-llm-via-executa-yv49p6ce
```

If you are currently operating on an Intel Mac, this chapter can only build: `darwin-x86_64`. This is normal.

Do not try to force-build Linux or macOS Apple Silicon binaries locally. PyInstaller’s output is closely tied to the current system, and local cross-platform packaging can easily produce files that cannot run.

We will hand real multi-platform builds to GitHub Actions.

In the next chapter, we will put the `package_binary.sh` written in this chapter into a GitHub Actions matrix, letting GitHub automatically run it on different platform runners and produce:

```
tool-youming-llm-via-executa-yv49p6ce-darwin-arm64.tar.gz
tool-youming-llm-via-executa-yv49p6ce-darwin-x86_64.tar.gz
tool-youming-llm-via-executa-yv49p6ce-linux-x86_64.tar.gz
```

### Chapter Summary

In this chapter, we completed the first real binary packaging:
* wrote a `package_binary.sh`;
* automatically read `tool_id` and `version` from `executa.json`;
* used PyInstaller to generate a single-file binary;
* organized the binary into the `bin/` directory;
* automatically generated `manifest.json` at the archive root;
* packaged it as `.tar.gz`;
* output the `sha256`, `size`, `entrypoint`, and `format` needed for later platform configuration;
* extracted it locally and verified that the binary can respond to describe.

At this point, we can already generate a standard Anna Executa binary archive for the current platform.

In the next chapter, we will move this workflow to GitHub Actions, letting it automatically build artifacts for multiple platforms and upload them to GitHub Release.

## Chapter 5: Hand It to GitHub Actions: Automatically Build Multi-Platform Binaries

In the previous chapter, we built a binary archive for the current platform locally.

But for real publishing, providing only one platform is not enough. At minimum, we want to cover these three common platforms first:
* `darwin-arm64`
* `darwin-x86_64`
* `linux-x86_64`

That is:
* macOS Apple Silicon;
* macOS Intel;
* Linux x86_64.

PyInstaller cannot reliably produce binaries for all platforms on a single machine. The most stable approach is: let the GitHub Actions runner for each platform build the package for that platform.

In this chapter, we will write a workflow that lets GitHub Actions automatically run the `package_binary.sh` from the previous chapter on different runners, then upload the generated `.tar.gz` and `.sha256` files to GitHub Release.

### First Commit All Previous Changes

Before continuing, confirm that all files you changed earlier have been committed.

Because earlier, we did not only add the packaging script. We may also have modified these files:

```
examples/anna-app-llm-demo/executas/llm-via-executa-python/executa.json
examples/anna-app-llm-demo/executas/llm-via-executa-python/pyproject.toml
examples/anna-app-llm-demo/executas/llm-via-executa-python/uv.lock
examples/anna-app-llm-demo/executas/llm-via-executa-python/package_binary.sh
```

If these changes are not committed, GitHub Actions will not see them in the remote repository. Later packaging may still use the old placeholder `tool_id`.

First check the current changes:

```bash
git status
```

After confirming these changes are what you want GitHub Actions to use, commit them directly:

```bash
git add .
git commit -m "Prepare llm-via-executa binary packaging"
```

Then push to your own fork:

```bash
git push
```

Emphasizing this point:
GitHub Actions runs the code in the GitHub repository, not files that are still uncommitted in your local working tree.
You need to push to your own fork, not the official repository.

### Add the GitHub Actions Workflow

At the repository root, create:

```
.github/workflows/build-llm-via-executa-binary.yml
```

with the following content:

```yaml
name: Build llm-via-executa binaries

on:
  workflow_dispatch:

permissions:
  contents: write

env:
  EXECUTA_DIR: examples/anna-app-llm-demo/executas/llm-via-executa-python

jobs:
  meta:
    runs-on: ubuntu-latest
    outputs:
      tool_id: ${{ steps.meta.outputs.tool_id }}
      version: ${{ steps.meta.outputs.version }}
      slug: ${{ steps.meta.outputs.slug }}
      tag: ${{ steps.meta.outputs.tag }}
    steps:
      - uses: actions/checkout@v4

      - id: meta
        run: |
          python3 - <<'PY' >> "$GITHUB_OUTPUT"
          import json
          from pathlib import Path

          p = Path("examples/anna-app-llm-demo/executas/llm-via-executa-python/executa.json")
          data = json.loads(p.read_text("utf-8"))

          tool_id = data["tool_id"]
          version = data.get("version") or "0.0.0"
          slug = data.get("slug") or "llm-via-executa"
          tag = f"{slug}-v{version}"

          print(f"tool_id={tool_id}")
          print(f"version={version}")
          print(f"slug={slug}")
          print(f"tag={tag}")
          PY

  build:
    needs: meta
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        include:
          - platform: darwin-arm64
            os: macos-14
          - platform: darwin-x86_64
            os: macos-15-intel
          - platform: linux-x86_64
            os: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"

      - uses: astral-sh/setup-uv@v5

      - name: Build binary archive
        working-directory: ${{ env.EXECUTA_DIR }}
        env:
          TOOL_ID: ${{ needs.meta.outputs.tool_id }}
          PLATFORM: ${{ matrix.platform }}
        run: |
          chmod +x package_binary.sh
          ./package_binary.sh

          expected="dist-anna/$TOOL_ID-$PLATFORM.tar.gz"
          test -f "$expected"

      - name: Write sha256 file
        working-directory: ${{ env.EXECUTA_DIR }}
        env:
          TOOL_ID: ${{ needs.meta.outputs.tool_id }}
          PLATFORM: ${{ matrix.platform }}
        run: |
          archive="dist-anna/$TOOL_ID-$PLATFORM.tar.gz"

          if command -v shasum >/dev/null 2>&1; then
            shasum -a 256 "$archive" > "$archive.sha256"
          else
            sha256sum "$archive" > "$archive.sha256"
          fi

          cat "$archive.sha256"

      - name: Upload build artifact
        uses: actions/upload-artifact@v4
        with:
          name: ${{ needs.meta.outputs.tool_id }}-${{ matrix.platform }}
          path: |
            ${{ env.EXECUTA_DIR }}/dist-anna/${{ needs.meta.outputs.tool_id }}-${{ matrix.platform }}.tar.gz
            ${{ env.EXECUTA_DIR }}/dist-anna/${{ needs.meta.outputs.tool_id }}-${{ matrix.platform }}.tar.gz.sha256

  release:
    needs: [meta, build]
    runs-on: ubuntu-latest
    steps:
      - name: Download build artifacts
        uses: actions/download-artifact@v4
        with:
          path: release-assets
          merge-multiple: true

      - name: List release assets
        run: |
          find release-assets -type f -maxdepth 1 -print | sort

      - name: Create or update GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          tag_name: ${{ needs.meta.outputs.tag }}
          name: ${{ needs.meta.outputs.slug }} v${{ needs.meta.outputs.version }}
          make_latest: false
          fail_on_unmatched_files: true
          files: release-assets/*
```

This workflow is divided into three jobs:
* `meta`: reads `executa.json` to get `tool_id`, `version`, `slug`, and the release tag.
* `build`: calls `package_binary.sh` separately on three runners.
* `release`: aggregates all build artifacts and uploads them to GitHub Release.

### Commit the Workflow

After adding the workflow, commit all changes again:

```bash
git status
git add .
git commit -m "Add llm-via-executa release workflow"
git push
```

If `git status` shows unrelated files you do not want to commit, handle them before `git add .`.

But for this tutorial path, the earlier changes to `executa.json`, `pyproject.toml`, `uv.lock`, `package_binary.sh`, and the workflow should all enter the same remote repository state.

### Manually Run the Workflow

Open your GitHub repository page and go to:
`Actions -> Build llm-via-executa binaries`

Click: `Run workflow`
Choose the branch containing your latest commit, then run it.

Note: if you modified the workflow, do not click Re-run jobs in an old failed record. That may still use the old workflow. You should return to the workflow page and click Run workflow again, and confirm the branch points to the version containing your latest commit.

### What Do You Get After It Succeeds?

After the workflow succeeds, enter the GitHub Release page. You should see a tag:

```
llm-via-executa-v0.1.0
```

Inside, there will be these assets:

```
tool-youming-llm-via-executa-yv49p6ce-darwin-arm64.tar.gz
tool-youming-llm-via-executa-yv49p6ce-darwin-arm64.tar.gz.sha256

tool-youming-llm-via-executa-yv49p6ce-darwin-x86_64.tar.gz
tool-youming-llm-via-executa-yv49p6ce-darwin-x86_64.tar.gz.sha256

tool-youming-llm-via-executa-yv49p6ce-linux-x86_64.tar.gz
tool-youming-llm-via-executa-yv49p6ce-linux-x86_64.tar.gz.sha256
```

These files are the binary download assets that we will fill into the Anna platform Tool binary distribution in the next chapter.

### Chapter Summary

In this chapter, we moved the local packaging flow to GitHub Actions.

We completed several things:
* confirmed that all files changed earlier need to be committed, including `executa.json`, `pyproject.toml`, `uv.lock`, `package_binary.sh`, and the new workflow;
* used `git add .` and `git commit` to push local changes to your own fork, ensuring GitHub Actions can read the latest configuration;
* selected three build environments according to GitHub’s official runner labels:
  * `macos-14` builds `darwin-arm64`;
  * `macos-15-intel` builds `darwin-x86_64`;
  * `ubuntu-latest` builds `linux-x86_64`;
* added the `build-llm-via-executa-binary.yml` workflow;
* let the workflow automatically read `tool_id`, `version`, and `slug` from `executa.json`;
* used a matrix to run the same `package_binary.sh` on different runners;
* generated `.tar.gz` and `.sha256` for each platform;
* finally, used a separate release job to aggregate all build artifacts and upload them to GitHub Release.

At this point, we can do more than package locally. We now have a remotely reproducible build flow. Every time you update Executa code later, you only need to commit the changes and rerun this workflow to get a new set of multi-platform binary Release assets.

In the next chapter, we will return to the Anna platform and configure these GitHub Release download URLs in the Tool’s binary distribution, so Anna Agent can truly install and start this Executa through the binary path.

## Chapter 6: Configure Binary Distribution on the Anna Platform and Reinstall on the Local Agent

In the previous chapter, we built binary archives for three platforms through GitHub Actions and uploaded them to GitHub Release.

Right now, these `.tar.gz` files are only “download files placed on GitHub”. Anna Agent does not yet know where to download them.

In this chapter, we will return to the Anna platform, switch the distribution mode of the LLM via Executa Tool to Binary, and fill in the GitHub Release download URLs generated earlier.

After that, we will reinstall this Tool on the local Agent and confirm that it no longer starts in Local mode, but downloads and runs through Binary mode.

### First Check Whether the Local Agent Still Has the Local Version Installed

If you followed the previous tutorial all the way through, your local Agent has probably already installed this Tool.

But it was likely installed through Local mode before, meaning it was started directly from your local development directory instead of downloading a binary from GitHub Release.

Let’s check first.

In the lower-left corner of the Anna page, go to:
`More -> Agents`

After entering the local Agents management page, find your local Agent.

Click: `Details` on the Agent card.

This opens the list of plugins currently installed on this Agent.

Find: `LLM via Executa` in the list.

If the text below it says: `Local` then the current Agent still has the local development version installed, not the binary distribution version.

In this case, first click the trash icon on the right to delete this Local version. After clicking, this tool will enter the Not Installed state.

This deletes the local plugin instance installed on the current Agent. It does not delete the Tool definition on the platform. The LLM via Executa Tool on the platform still exists, and later we will let the Agent reinstall it through Binary mode.

If you already see it displayed as: `Binary` you can leave it for now. But if after configuring Binary later you find that the Agent did not redownload it, you can come back, delete the old installation, and reinstall.

### Edit the Tool Configuration on the Platform

Next, enter the Executa page and find: `LLM via Executa`. Open the edit page.

Note: In Visibility — controls Hub publishing & AnnaApp packaging, the Tool must be set to `public` or `app_bundled`, not `private`. This Tool is bound to the AnnaApp and needs to be shared with other users together with the App. If it remains private, other users will not be able to access the Tool, and the App will not be able to invoke it properly on their side.

There is also a small bug observed in practice: every time you reopen the Edit page, Visibility may default back to `private`. Before saving, always check this field manually and change it back to `public` or `app_bundled` if needed.

In the Distribution area, set:
Distribution Type to: `Binary`

This step means: this Tool no longer requires the Agent to start it from a local path or source environment. Instead, it is installed through binary download URLs.

The page may have a single-platform download URL input: `Download URL (Single Platform)`. This field is suitable for simple cases where there is only one platform package. We have now built multiple platforms, so focus on the section below:

`Multi-platform Binary Download URLs`

### Fill in the Release Download URLs for the Three Platforms

Click: `Add Platform`

Add the following three platforms:
* macOS ARM64 (Apple Silicon)
* macOS x86_64 (Intel)
* Linux x86_64

Then fill in the corresponding download URLs from the GitHub Release in the previous chapter.

Assume your GitHub username is: `<your-github-username>`
your Tool ID is: `tool-<handle>-llm-via-executa-yv49p6ce`
and the version is: `0.1.0`

Then the three download URLs are roughly:

```
https://github.com/<your-github-username>/anna-executa-examples/releases/download/llm-via-executa-v0.1.0/tool-<handle>-llm-via-executa-yv49p6ce-darwin-arm64.tar.gz
https://github.com/<your-github-username>/anna-executa-examples/releases/download/llm-via-executa-v0.1.0/tool-<handle>-llm-via-executa-yv49p6ce-darwin-x86_64.tar.gz
https://github.com/<your-github-username>/anna-executa-examples/releases/download/llm-via-executa-v0.1.0/tool-<handle>-llm-via-executa-yv49p6ce-linux-x86_64.tar.gz
```

Please replace `<your-github-username>` with your GitHub username. Also replace `tool-<handle>-llm-via-executa-yv49p6ce` with your own Tool ID.

### Let the Local Agent Reinstall This Tool

After saving the Tool configuration, go back to: `More -> Agents`
Find your local Agent.

Click: `Install Essentials`

The Agent will pull the Tool configuration from the platform again and download the binary package for the corresponding platform according to the current Binary distribution mode.

This process may take a while. After the download completes, click: `Details` again.

Find: `LLM via Executa`.
This time, the text below it should show: `Binary` and the status should be: `Running`.

This means the local Agent is no longer starting this Tool from the local source directory. It has downloaded the binary package for the corresponding platform from GitHub Release and successfully started it.

### FAQ: What If Details Still Shows Not Installed?

After configuration, under normal conditions we expect to see this in the Agent Details page:

```
LLM via Executa
Binary
Running
```

But sometimes you may still see: `Not Installed`.

This means the Agent did not successfully install this Tool.

Do not rush to repeatedly click Install Essentials. Problems like this are usually not because the button was not clicked, but because the binary distribution configuration, archive structure, or plugin protocol itself has an issue. You can troubleshoot in the following directions.

#### Check Whether `manifest.json` in the Archive Is Correct

First, check whether the `.tar.gz` you uploaded to GitHub Release really contains `manifest.json`.

After downloading the archive for the corresponding platform, inspect it like this:

```bash
tar tzf tool-youming-llm-via-executa-yv49p6ce-darwin-arm64.tar.gz
```

You should see something like:

```
./bin/
./bin/tool-youming-llm-via-executa-yv49p6ce
./manifest.json
```

Then extract it and inspect `manifest.json`:

```bash
mkdir -p /tmp/llm-via-executa-check
tar xzf tool-youming-llm-via-executa-yv49p6ce-darwin-arm64.tar.gz -C /tmp/llm-via-executa-check
cat /tmp/llm-via-executa-check/manifest.json
```

Focus on this field:

```json
{
  "runtime": {
    "binary": {
      "entrypoint": {
        "default": "bin/tool-youming-llm-via-executa-yv49p6ce"
      }
    }
  }
}
```

`runtime.binary.entrypoint.default` must point to a binary file path that truly exists inside the archive.

If your archive structure is: `bin/tool-youming-llm-via-executa-yv49p6ce` then the entrypoint should be: `bin/tool-youming-llm-via-executa-yv49p6ce`.

If it is written as: `tool-youming-llm-via-executa-yv49p6ce` or as a nonexistent path, the Agent will not find the entry after extraction and naturally cannot install successfully.

#### Check Whether the Binary File Can Actually Run

Sometimes the archive structure looks correct, but the binary inside cannot run.

After extraction, execute it directly:

```bash
/tmp/llm-via-executa-check/bin/tool-youming-llm-via-executa-yv49p6ce
```

If it errors immediately, or says a dynamic library is missing, a Python module is missing, or permission is insufficient, then the problem is in the packaged artifact itself.

The better check is to directly send it a JSON-RPC request:

```bash
printf '%s\n' '{"jsonrpc":"2.0","method":"describe","id":1}' \
  | /tmp/llm-via-executa-check/bin/tool-youming-llm-via-executa-yv49p6ce
```

A valid Anna Executa Tool should at least respond normally to `describe`.

If this fails, then although the binary exists, it is not a usable Executa Tool. Common reasons include:
* PyInstaller did not package dependencies;
* the Python entry point is wrong;
* the program does not read stdin after startup;
* the program does not output according to the JSON-RPC over stdio protocol;
* the program prints non-JSON content to stdout at startup, polluting the protocol output;
* the program exits immediately after startup.

Anna Agent is only responsible for starting the process and communicating with it through stdio JSON-RPC. It will not fix a binary that does not conform to the protocol by itself.

#### Check Whether the Platform Matches

Agent selects the download URL based on its own platform.

For example, if your Agent is an Apple Silicon Mac, it needs: `darwin-arm64`
If your Agent is an Intel Mac, it needs: `darwin-x86_64`
If your Agent is Linux x86_64, it needs: `linux-x86_64`

If you only uploaded `darwin-arm64`, but the current Agent is `darwin-x86_64`, installation will fail.

You can go back to the Agent page to view the current machine’s platform information. Then confirm that the Tool’s Binary configuration has the download URL for that platform.

Also confirm that you did not swap the platform and URL. For example: `macOS ARM64` should not be filled with `...-darwin-x86_64.tar.gz`, but should be filled with `...-darwin-arm64.tar.gz`.

#### Check Whether the GitHub Release Link Is Correct

The Binary URL must be directly downloadable by the Agent.

Copy the URL you filled into the platform and open it in a browser to confirm it can directly download the `.tar.gz` file.

You can also test it with a command:

```bash
curl -L -I "https://github.com/<your-github-username>/anna-executa-examples/releases/download/llm-via-executa-v0.1.0/<asset-name>.tar.gz"
```

If it returns 404, the link is wrong. Common mistakes include:
* the GitHub username is wrong;
* the repository name is wrong;
* the Release tag is wrong;
* the asset file name is wrong;
* the version number is inconsistent;
* you copied the URL from the official repository instead of your own fork;
* the Release has not successfully generated the asset for the corresponding platform.

If the repository is private, also confirm that the environment where the Agent runs has permission to download this file. To reduce pitfalls during the tutorial stage, it is recommended to first use a public fork or a publicly accessible Release asset.

### Chapter Summary

In this chapter, we completed the real binary distribution configuration:
* checked and deleted the old Local installation in Agent Details;
* entered the Executa page and edited LLM via Executa;
* switched Distribution Type to Binary;
* filled in GitHub Release download URLs for macOS ARM64, macOS x86_64, and Linux x86_64;
* returned to the Agents page and clicked Install Essentials;
* entered Details again and confirmed that LLM via Executa shows Binary and status Running.

At this point, this Tool can already be downloaded and started by Anna Agent through the binary path. In other words, we have gone from “a Python Executa that can run locally” to “a platform-distributable Binary Executa”.
