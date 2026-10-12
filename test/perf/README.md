# Local performance sampler

Run this only against a disposable Markdown document. It inserts text into the active editor.

Launch VS Code with a DevTools port after installing the release VSIX:

```sh
code --user-data-dir=/tmp/live-markdown-perf-user \
  --extensions-dir=/tmp/live-markdown-perf-extensions \
  --remote-debugging-port=9231 --new-window
```

Open a fixture in the Live Markdown custom editor, then run:

```sh
node test/perf/benchmark.mjs 100 35
```

The arguments are sample count, delay between input events in milliseconds, text inserted for each event, and maximum wait for acknowledgements. For example, `node test/perf/benchmark.mjs 100 35 "$(python3 -c 'print("z" * 1024)')"` sends 100 large-paste events. Set `LIVE_MARKDOWN_CDP_PORT` to use another port.

The sampler requires every requested start sample, visible source DOM mutation, and compositor frame swap; it fails instead of presenting partial coverage. It reports input-to-animation-frame timings as rendering proxies, input-to-visible-source mutation, input-to-compositor-frame-swap timestamps aligned through `performance.timeOrigin`, screencast event-arrival timings, input-to-host-acknowledgement timings, durable-recovery wait, extension-host edit-preparation time, `WorkspaceEdit` wait, and observed long tasks. Normal Live Markdown runs start at `beforeinput`, before CodeMirror handles the edit, and a monotonic webview revision attributes coalesced host acknowledgements to each input event. For a paired native comparison, set `LIVE_MARKDOWN_CDP_EDITOR=native` in the native profile and `LIVE_MARKDOWN_CDP_START=dispatch` in the Live Markdown profile. Both runs then use a renderer-side timestamp immediately before the same CDP `Input.insertText` command. Native runs omit host-acknowledgement metrics. The previous local native comparison attempt failed the visible-mutation check and is not release evidence; the stricter sampler now rejects any run without one visible source mutation per input. CDP documents the screencast metadata timestamp as a compositor frame-swap timestamp; the separately reported event-arrival metric includes capture and transport delay. A frame-swap timestamp is stronger evidence than an animation-frame callback, but does not prove photons reached the physical display. Use a browser trace or screen recording when a display-confirmed measurement is required. Record the VS Code version, OS, machine, fixture size, extension build, other enabled extensions, and whether the workspace is local or remote. Local samples from this machine are in [results.md](results.md).

To run a paired native-source and Live Markdown sample with the same 100 KiB fixture, use the isolated-profile coordinator. It opens the fixture in each editor, runs the sampler, and removes both temporary profiles afterward. Keep the VS Code window in the foreground throughout the run. Use a small sample count to check setup before collecting release data:

```sh
LIVE_MARKDOWN_BENCHMARK_SAMPLES=5 node test/perf/paired-benchmark/run.mjs
```

The default is 100 samples at 35 ms intervals. `VSCODE_EXECUTABLE` selects the VS Code binary and `LIVE_MARKDOWN_BENCHMARK_PORT` selects its temporary CDP port. A result is emitted only when every input changes visible source and is matched to a compositor frame. This is still a DOM/compositor measurement, not physical display confirmation.

To sample visible emphasis formatting separately, open a clean disposable 100 KiB fixture and run:

```sh
LIVE_MARKDOWN_FORMATTING_PROBE=1 node test/perf/benchmark.mjs 100 35 '**LiveFormatProbe** '
```

Each beforeinput inserts a complete bold span. The probe observes when the corresponding `.lm-strong` mark appears in CodeMirror's rendered DOM, then finds the next compositor frame-swap timestamp after that mutation. This separates beforeinput-to-formatting-DOM update from the following compositor frame. It still does not confirm physical display output; do not reuse the already edited fixture for another baseline run.

To measure opening 100 KiB files through the CLI in a running instance, enable the same CDP port and pass disposable fixture paths to `open-benchmark.mjs`. It verifies the requested active filename and Live Markdown webview before recording editable DOM readiness and a compositor frame. Each fixture must have different content in its first 4 KiB. Keep the window foregrounded; the harness cannot verify OS-level focus. A compositor frame-swap is a proxy for first paint, not proof of photons at the display.

For Explorer-driven open timing, start a foreground VS Code instance with the target fixture folder visible in the Files Explorer and remote debugging enabled, then pass the same fixtures to `explorer-open-benchmark.mjs`:

```sh
LIVE_MARKDOWN_CDP_PORT=9243 \
  node test/perf/explorer-open-benchmark.mjs /tmp/live-markdown-fixtures/doc-*.md
```

The script scrolls each requested Explorer row fully into view, dispatches a click to that row, then confirms the active filename and editable Live Markdown webview. It reports Explorer-click-to-editable and tab-activation-to-editable distributions, plus the timestamp of the first captured workbench screencast frame after the webview becomes editable. These use CDP mouse events and screencast timestamps; they do not measure physical mouse input or photons at the display. Keep the VS Code window foregrounded throughout. For release evidence, also run separate cold and warm scenarios and compare with the native editor.

## Memory sampling

Create a repeatable local fixture set:

```sh
node test/perf/prepare-memory-fixtures.mjs /tmp/live-markdown-memory-fixtures 200 3641
```

Install the VSIX in a fresh isolated profile, then launch the fixture folder with the memory-probe extension:

```sh
code --user-data-dir=/tmp/live-markdown-memory-user \
  --extensions-dir=/tmp/live-markdown-memory-extensions \
  --install-extension ./live-markdown-0.1.0.vsix
code --user-data-dir=/tmp/live-markdown-memory-user \
  --extensions-dir=/tmp/live-markdown-memory-extensions \
  --extensionDevelopmentPath="$PWD/test/perf/memory-probe" \
  --remote-debugging-port=9231 /tmp/live-markdown-memory-fixtures
```

After the profile settles, record a blank-workspace process-tree memory sample. Open the command palette and run **Live Markdown Memory Probe: Open Fixture Set**. Confirm the fixture tabs and Live Markdown webviews, then sample again after a fixed idle interval. Repeat with the same VS Code build, fixture set, and profile topology. On macOS, `footprint` can report process dirty memory in addition to the `ps` RSS total; RSS and dirty-memory results must be labeled separately. Samples are diagnostic until repeated across clean profiles and attributed to the extension rather than the whole VS Code process tree. The latest local 200-editor diagnostic is in [results.md](results.md).

For a repeatable run without using the command palette, the extension test runner opens every fixture in a disposable VS Code profile, samples the blank, all-editors-open, and post-close process tree once per second, prints per-phase RSS distributions and process counts, then removes the profile. By default it loads Live Markdown and opens each document in the custom editor. Set `LIVE_MARKDOWN_MEMORY_MODE=native` to omit Live Markdown and open the same fixtures in VS Code's native text editor for a matched baseline. Set `LIVE_MARKDOWN_MEMORY_BLANK_HOLD_MS` to let startup settle before opening editors, `LIVE_MARKDOWN_MEMORY_HOLD_MS` to extend the all-editors-open sampling window, and `LIVE_MARKDOWN_MEMORY_CLOSED_HOLD_MS` to extend the post-close window. Set `LIVE_MARKDOWN_MEMORY_SUMMARY_FILE` to preserve the complete JSON result, including raw per-process-type samples. `VSCODE_EXECUTABLE` can point to another VS Code binary:

```sh
LIVE_MARKDOWN_MEMORY_HOLD_MS=30000 \
  node test/perf/memory-probe/run.js /tmp/live-markdown-memory-fixtures
```

For a matched native-editor comparison, run the same fixture set twice with fresh profiles, changing `LIVE_MARKDOWN_MEMORY_MODE` to `native` for the control and `live` for the extension build. Give each run a different `LIVE_MARKDOWN_MEMORY_SUMMARY_FILE` path so both JSON samples are retained.

The runner's summary contains raw samples as well as min, p50, p95, and max values. Sampling misses are counted. On macOS it also calls `footprint` every five samples and reports per-process physical-footprint data separately from RSS. For an optional one-off manual RSS sample during a run, use the printed profile's `user` directory:

```sh
node test/perf/memory-probe/sample-process-tree.mjs <path>/user
```

The sampler reports aggregate RSS for the VS Code process tree, including VS Code itself and built-in services; it does not attribute memory to the extension. Repeat with fresh profiles for meaningful comparisons.
