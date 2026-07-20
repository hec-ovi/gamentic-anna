1. What Is Cloud Agent?
Cloud Agent is a remote Agent runtime environment hosted by the Anna platform. It runs Agent sessions, schedules tools, and starts or connects to Executa components that the user has installed and authorized in the cloud.

Cloud Agent does not mean that the entire Anna App runs in the cloud. A typical Anna App still spans multiple runtime locations:

- App frontend: An iframe in the user’s browser

- Agent Runtime: The Anna cloud

- Executa: The Cloud Agent execution environment

- Files and persistent data: Anna Persistent Storage

In Local Agent mode, the Agent Runtime and Executa usually run on the user’s computer.

Cloud Agent is therefore not a new Executa format. It is another environment in which Executa is run and orchestrated. The tool_id, Executa manifest, Tool invocation method, and stdio JSON-RPC protocol remain valid, but the filesystem, network location, persistence model, and debugging workflow are different.

2. What Does Cloud Agent Mean for Users?
For users, the main benefit of Cloud Agent is that it reduces local runtime dependencies.

Users do not need to keep a Local Agent running on their own computer because tasks can be executed entirely in the cloud. There is no need to download Anna Agent: users can simply visit the Anna website and use Cloud Agent out of the box.

Usage Instructions
1. Enable Cloud Agent and make it the default Agent
Click More > Agents to open the Agents management page.

屏幕截图 2026-07-17 180837
330×762 21.6 KB
Enable Cloud Agents and set it as the default Agent.

屏幕截图 2026-07-17 181215
屏幕截图 2026-07-17 181215
701×482 14 KB
2. Download an App
Go to the App Store and click Install to download the App.

The Cloud Agent automatically downloads the tools required by the App.

If a tool fails to download, go to More > Installed Apps, locate the App marked NEEDS REPAIR, and click Repair to download the tool again.

屏幕截图 2026-07-17 182207
屏幕截图 2026-07-17 182207
1177×280 13.1 KB
3. Grant permissions
After the tool and App have finished downloading, go to More > Installed Apps, locate the App, and click Permissions to grant the required permissions to the App and its tools.

屏幕截图 2026-07-17 182859
屏幕截图 2026-07-17 182859
1212×128 7.91 KB

屏幕截图 2026-07-17 183040
屏幕截图 2026-07-17 183040
876×843 103 KB
4. Choose your preferred or best-performing model
Click More > Advanced > LLM, then select the LLM model that best suits your subscription plan and requirements.

3. What Does Cloud Agent Mean for Developers?
3.1 The Local Agent publishing workflow remains fully applicable
Cloud Agent essentially moves the Agent that runs Executa from the user’s computer to the cloud. Using Cloud Agent therefore does not change:

- How a tool_id is created

- The Executa code entry point

- The stdio JSON-RPC protocol

- The GitHub Actions packaging workflow

- Distribution through GitHub Releases

- The App publishing workflow using anna-app apps push

Previously generated binaries can continue to be used; there is no need to create a separate Executa format specifically for Cloud Agent.

However, make sure that the GitHub Release contains the platform artifact required by Cloud Agent. Specifically, confirm that a linux-x86_64 release artifact is available.

3.2 Migrating frontend-backend communication away from http://localhost
3.2.1 Limitations of local HTTP transport
Anna Apps usually communicate with Executa through Tool calls, with stdio JSON-RPC used as the underlying transport. When uploading or returning large files, or transferring a large amount of text in a single operation, the platform’s buffer-size limit for a single-line stdio JSON-RPC request or response may become an issue.

For this reason, some Executa components also start a local HTTP service. Tool calls are then used only to create a task or return a task ID, while the App frontend uses HTTP endpoints to upload files, query task progress, or retrieve larger execution results.

In Local Agent mode, Executa runs on the user’s computer. If the App frontend accesses a local service at an address such as:

http://localhost:<port>

the browser’s localhost and the machine running Executa refer to the same local environment, so this approach works correctly.

After switching to Cloud Agent, the runtime locations change:

- App frontend: The user’s browser

- Executa: Anna Cloud Agent

In this setup, the following address in frontend code:

http://localhost:<port>

still points to the user’s own computer, not to Cloud Agent. The frontend therefore cannot use localhost to access an Executa process running in the cloud.

3.2.2 Cloud-based large-file transfer
After deployment to the Cloud Agent environment, do not continue to use http://127.0.0.1 or localhost to transfer data between the App frontend and Executa, because the user’s browser and the cloud-hosted Executa do not share the same network environment.

Control requests from the App to Executa should continue to be sent through anna.tools.invoke. The Anna platform routes each Tool call and delivers it to Executa over stdio JSON-RPC. JSON-RPC should be used only to transfer operation instructions, APS object paths, task status, and small amounts of metadata.

For large data that may exceed the JSON-RPC single-frame limit, use Anna Persistent Storage (APS Files):

- Transferring data from Executa to the frontend: First call files/upload_begin to obtain a presigned upload URL, upload the content to APS, and then call files/upload_complete to persist it. The tool response should return only the object path. If the content needs to be read immediately, files/download_url can also return a short-lived download URL that allows the frontend to retrieve the content directly from APS.

- Transferring large data from the frontend to Executa: First upload the content to APS. Then pass the object path to Executa through anna.tools.invoke; Executa can obtain a download URL and read the content.

- Persisting data long-term: Store only the stable APS object path. Do not persist presigned URLs, because they expire.

Executa must declare the aps.files capability and access APS through reverse-RPC interfaces such as files/upload_begin, files/upload_complete, files/download_url, files/list, and files/delete.

For detailed API documentation, see Executa Persistent Storage. For an implementation example, refer to Anna App APS Files Demo.
