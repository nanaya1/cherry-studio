import { exec, execFile, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import * as path from 'path'

import * as fs from 'fs-extra'

import { application } from '@application'
import { loggerService } from '@logger'
import {
  BaseService,
  Conditional,
  Injectable,
  onCpuVendor,
  onPlatform,
  Phase,
  ServicePhase
} from '@main/core/lifecycle'

const logger = loggerService.withContext('OvmsManager')

const execAsync = promisify(exec)
// const execFileAsync = promisify(execFile) // original: promisified execFile used by addModel; no owned handle to cancel. Replaced by the callback form in addModel to retain a stoppable, owned handle (and to drain stdout/stderr).

interface OvmsProcess {
  pid: number
  path: string
  workingDirectory: string
}

interface ModelConfig {
  name: string
  base_path: string
}

interface OvmsConfig {
  mediapipe_config_list: ModelConfig[]
}

@Injectable('OvmsManager')
@ServicePhase(Phase.WhenReady)
@Conditional(onPlatform('win32'), onCpuVendor('intel'))
export class OvmsManager extends BaseService {
  private ovms: OvmsProcess | null = null
  // Owned handles: only these may be terminated. Never treat a scanned PID as owned.
  private ovmsChild: ChildProcess | null = null
  private downloadChild: ChildProcess | null = null
  // Once lifecycle shutdown runs, never (re)start an owned process.
  private stopped = false
  private static readonly POWERSHELL_TIMEOUT_MS = 10000
  private static readonly MAX_DOWNLOAD_BUFFER = 64 * 1024 * 1024

  protected async onStop() {
    this.stopped = true
    const failures: string[] = []
    // Stop the owned OVMS process tree (no-op if none is owned).
    const ovmsResult = await this.stopOvms()
    if (!ovmsResult.success) {
      failures.push(ovmsResult.message ?? 'Failed to stop OVMS process')
    }
    // Also stop any owned model download so a lingering ovdnd.exe is not left behind.
    const downloadResult = await this.stopAddModel()
    if (!downloadResult.success) {
      failures.push(downloadResult.message ?? 'Failed to stop model download')
    }
    // Shutdown is irreversible: forbid any further runOvms/addModel from starting a process.
    this.stopped = true
    if (failures.length > 0) {
      throw new Error(failures.join('; '))
    }
  }

  /**
   * Recursively terminate a process and all its child processes
   * @param pid Process ID to terminate
   * @returns Promise<{ success: boolean; message?: string }>
   */
  private async terminalProcess(pid: number): Promise<{ success: boolean; message?: string }> {
    // Never act on an invalid PID. `child.pid ?? -1` can be -1 when a process failed to
    // report a PID; sending that to Stop-Process would target PID -1 (every process in the
    // session), which is unsafe. Refuse instead so the caller keeps its owned handle.
    if (!Number.isInteger(pid) || pid <= 0) {
      logger.error(`Refusing to terminate invalid PID: ${pid}`)
      return { success: false, message: `Invalid PID: ${pid}` }
    }
    const ps = (command: string) =>
      execAsync(`powershell -Command "${command}"`, {
        timeout: OvmsManager.POWERSHELL_TIMEOUT_MS,
        windowsHide: true
      })
    try {
      // Check if the process is running
      const processCheckCommand = `Get-Process -Id ${pid} -ErrorAction SilentlyContinue | Select-Object Id | ConvertTo-Json`
      const { stdout: processStdout } = await ps(processCheckCommand)

      if (!processStdout.trim()) {
        logger.info(`Process with PID ${pid} is not running`)
        return { success: true, message: `Process with PID ${pid} is not running` }
      }

      // Find child processes
      const childProcessCommand = `Get-WmiObject -Class Win32_Process | Where-Object { $_.ParentProcessId -eq ${pid} } | Select-Object ProcessId | ConvertTo-Json`
      const { stdout: childStdout } = await ps(childProcessCommand)

      // If there are child processes, terminate them first
      let childFailed = false
      if (childStdout.trim()) {
        const childProcesses = JSON.parse(childStdout)
        const childList = Array.isArray(childProcesses) ? childProcesses : [childProcesses]

        logger.info(`Found ${childList.length} child processes for PID ${pid}`)

        // Recursively terminate each child process; a non-clean child stop must be
        // propagated so the caller does not report a falsely successful teardown.
        for (const childProcess of childList) {
          const childPid = childProcess.ProcessId
          logger.info(`Terminating child process PID: ${childPid}`)
          const childResult = await this.terminalProcess(childPid)
          if (!childResult.success) {
            childFailed = true
            logger.warn(`Child process ${childPid} failed to terminate: ${childResult.message}`)
          }
        }
      } else {
        logger.info(`No child processes found for PID ${pid}`)
      }

      // Finally, terminate the parent process (-Force keeps OVMS's existing semantics)
      const killCommand = `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`
      await ps(killCommand)
      logger.info(`Terminated process with PID: ${pid}`)

      // Wait for the process to disappear with 5-second timeout
      const timeout = 5000 // 5 seconds
      const startTime = Date.now()

      while (Date.now() - startTime < timeout) {
        const checkCommand = `Get-Process -Id ${pid} -ErrorAction SilentlyContinue | Select-Object Id | ConvertTo-Json`
        const { stdout: checkStdout } = await ps(checkCommand)

        if (!checkStdout.trim()) {
          logger.info(`Process with PID ${pid} has disappeared`)
          if (childFailed) {
            return { success: false, message: `Process ${pid} terminated but a child failed to stop` }
          }
          return { success: true, message: `Process ${pid} and all child processes terminated successfully` }
        }

        // Wait 300ms before checking again
        await new Promise((resolve) => setTimeout(resolve, 300))
      }

      logger.warn(`Process with PID ${pid} did not disappear within timeout`)
      return { success: false, message: `Process ${pid} did not disappear within 5 seconds` }
    } catch (error) {
      logger.error(`Failed to terminate process ${pid}:`, error as Error)
      return { success: false, message: `Failed to terminate process ${pid}` }
    }
  }

  /**
   * Stop OVMS process if it's running
   * @returns Promise<{ success: boolean; message?: string }>
   */
  public async stopOvms(): Promise<{ success: boolean; message?: string }> {
    // Only terminate the process tree this app started; never scan-kill external ovms.exe.
    if (!this.ovms) {
      logger.info('No owned OVMS process to stop')
      return { success: true, message: 'No OVMS process owned by this app' }
    }
    const pid = this.ovms.pid
    try {
      // execAsync(`powershell -Command "Get-WmiObject Win32_Process | Where-Object { $_.CommandLine -like 'ovms.exe*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"`)  // old: killed external instances
      const result = await this.terminalProcess(pid)
      // Retain the owned handle on a non-clean stop so we never silently lose track of a
      // process this app started (and never report a false "stopped").
      if (result.success) {
        this.ovms = null
        this.ovmsChild = null
        logger.info('OVMS process stopped successfully')
        return { success: true, message: 'OVMS process stopped successfully' }
      }
      return result
    } catch (error) {
      logger.error(`Failed to stop OVMS process: ${error}`)
      return { success: false, message: 'Failed to stop OVMS process' }
    }
  }

  /**
   * Run OVMS by ensuring config.json exists and executing run.bat
   * @returns Promise<{ success: boolean; message?: string }>
   */
  public async runOvms(): Promise<{ success: boolean; message?: string }> {
    // After shutdown, never (re)start an owned process.
    if (this.stopped) {
      logger.warn('runOvms refused: manager is stopped')
      return { success: false, message: 'OVMS manager is stopped' }
    }
    const ovmsDir = application.getPath('feature.ovms.ovms')
    const configPath = path.join(ovmsDir, 'models', 'config.json')
    const runBatPath = path.join(ovmsDir, 'run.bat')

    try {
      // Check if config.json exists, if not create it with default content
      if (!(await fs.pathExists(configPath))) {
        logger.info(`Config file does not exist, creating: ${configPath}`)

        // Ensure the models directory exists
        await fs.ensureDir(path.dirname(configPath))

        // Create config.json with default content
        const defaultConfig = {
          mediapipe_config_list: [],
          model_config_list: []
        }

        await fs.writeJson(configPath, defaultConfig, { spaces: 2 })
        logger.info(`Config file created: ${configPath}`)
      }

      // Check if run.bat exists
      if (!(await fs.pathExists(runBatPath))) {
        logger.error(`run.bat not found at: ${runBatPath}`)
        return { success: false, message: 'run.bat not found' }
      }

      // Reuse the existing owned handle instead of overwriting it: a second run must not
      // orphan the first process tree (PID-reuse guard).
      if (this.ovms && this.ovmsChild && !this.ovmsChild.killed && this.ovmsChild.exitCode === null) {
        logger.info(`OVMS already running (PID ${this.ovms.pid}); reusing owned handle`)
        return { success: true }
      }

      // Run run.bat without waiting for it to complete
      logger.info(`Starting OVMS with run.bat: ${runBatPath}`)
      // exec(`"${runBatPath}"`, { cwd: ovmsDir }, (error) => { if (error) logger.error(`Error running run.bat: ${error}`) })  // old: no owned handle
      const child = exec(`"${runBatPath}"`, { cwd: ovmsDir }, (error) => {
        if (error) {
          logger.error(`Error running run.bat: ${error}`)
        }
        // Clear the owned handle when the wrapper process exits (guards PID reuse).
        if (this.ovmsChild === child) {
          this.ovmsChild = null
          this.ovms = null
        }
      })
      this.ovmsChild = child
      const pid = child.pid
      if (pid == null) {
        logger.error('Failed to obtain a PID for the OVMS process')
        this.ovmsChild = null
        return { success: false, message: 'Failed to start OVMS (no PID)' }
      }
      this.ovms = { pid, path: runBatPath, workingDirectory: ovmsDir }

      // Ownership note: the bundled run.bat is generated by resources/scripts/install-ovms.js,
      // which copies setupvars.bat and appends a *direct foreground* `ovms.exe ...` call (no
      // `start`/detach). So exec()'s cmd.exe child owns ovms.exe as a descendant and the whole
      // tree is killable via terminalProcess recursion. A user-edited run.bat using `start`
      // would detach ovms.exe and break this ownership — it is not asserted here.
      logger.info('OVMS wrapper started (owned handle tracked)')
      return { success: true }
    } catch (error) {
      logger.error(`Failed to run OVMS: ${error}`)
      return { success: false, message: 'Failed to run OVMS' }
    }
  }

  /**
   * Get OVMS status - checks installation and running status
   * @returns 'not-installed' | 'not-running' | 'running'
   */
  public async getOvmsStatus(): Promise<'not-installed' | 'not-running' | 'running'> {
    const ovmsPath = application.getPath('feature.ovms.ovms', 'ovms.exe')

    try {
      // Check if OVMS executable exists
      if (!(await fs.pathExists(ovmsPath))) {
        logger.info(`OVMS executable not found at: ${ovmsPath}`)
        return 'not-installed'
      }

      // Check if OVMS process is running (read-only probe; bounded like the stop paths)
      const psCommand = `Get-Process -Name "ovms" -ErrorAction SilentlyContinue | Select-Object Id, Path | ConvertTo-Json`
      const { stdout } = await execAsync(`powershell -Command "${psCommand}"`, {
        timeout: OvmsManager.POWERSHELL_TIMEOUT_MS,
        windowsHide: true
      })

      if (!stdout.trim()) {
        logger.info('OVMS process not running')
        return 'not-running'
      }

      const processes = JSON.parse(stdout)
      const processList = Array.isArray(processes) ? processes : [processes]

      if (processList.length > 0) {
        logger.info('OVMS process is running')
        return 'running'
      } else {
        logger.info('OVMS process not running')
        return 'not-running'
      }
    } catch (error) {
      logger.info(`Failed to check OVMS status: ${error}`)
      return 'not-running'
    }
  }

  /**
   * Initialize OVMS by finding the executable path and working directory
   */
  public async initializeOvms(): Promise<boolean> {
    // NOTE: the original implementation scanned `Get-Process -Name "ovms"` and adopted ANY
    // external ovms.exe as "owned", which let us kill processes we didn't start. The new
    // version only re-confirms the process this app actually started. Original code:
    /*
    const psCommand = `Get-Process -Name "ovms" -ErrorAction SilentlyContinue | Select-Object Id, Path | ConvertTo-Json`
    const { stdout } = await execAsync(`powershell -Command "${psCommand}"`)
    if (!stdout.trim()) {
      logger.error('Command to find OVMS process returned no output')
      return false
    }
    logger.debug(`OVMS process output: ${stdout}`)
    const processes = JSON.parse(stdout)
    const processList = Array.isArray(processes) ? processes : [processes]
    for (const process of processList) {
      this.ovms = { pid: process.Id, path: process.Path, workingDirectory: path.dirname(process.Path) }
      return true
    }
    return this.ovms !== null
    */
    if (!this.ovms || !this.ovmsChild) {
      return false
    }
    if (this.ovmsChild.killed || this.ovmsChild.exitCode !== null) {
      this.ovms = null
      this.ovmsChild = null
      return false
    }
    return true
  }

  /**
   * Check if the Model Name and ID are valid, they are valid only if they are not used in the config.json
   * @param modelName Name of the model to check
   * @param modelId ID of the model to check
   */
  public async isNameAndIDAvalid(modelName: string, modelId: string): Promise<boolean> {
    if (!modelName || !modelId) {
      logger.error('Model name and ID cannot be empty')
      return false
    }

    const configPath = path.join(application.getPath('feature.ovms.ovms'), 'models', 'config.json')
    try {
      if (!(await fs.pathExists(configPath))) {
        logger.warn(`Config file does not exist: ${configPath}`)
        return false
      }

      const config: OvmsConfig = await fs.readJson(configPath)
      if (!config.mediapipe_config_list) {
        logger.warn(`No mediapipe_config_list found in config: ${configPath}`)
        return false
      }

      // Check if the model name or ID already exists in the config
      const exists = config.mediapipe_config_list.some(
        (model) => model.name === modelName || model.base_path === modelId
      )
      if (exists) {
        logger.warn(`Model with name "${modelName}" or ID "${modelId}" already exists in the config`)
        return false
      }
    } catch (error) {
      logger.error(`Failed to check model existence: ${error}`)
      return false
    }

    return true
  }

  private async applyModelPath(modelDirPath: string): Promise<boolean> {
    const patchDir = application.getPath('feature.ovms.patch')
    if (!(await fs.pathExists(patchDir))) {
      return true
    }

    const modelId = path.basename(modelDirPath)

    // get all sub directories in patchDir
    const patchs = await fs.readdir(patchDir)
    for (const patch of patchs) {
      const fullPatchPath = path.join(patchDir, patch)

      if (fs.lstatSync(fullPatchPath).isDirectory()) {
        if (modelId.toLowerCase().includes(patch.toLowerCase())) {
          // copy all files from fullPath to modelDirPath
          try {
            const files = await fs.readdir(fullPatchPath)
            for (const file of files) {
              const srcFile = path.join(fullPatchPath, file)
              const destFile = path.join(modelDirPath, file)
              await fs.copyFile(srcFile, destFile)
            }
          } catch (error) {
            logger.error(`Failed to copy files from ${fullPatchPath} to ${modelDirPath}: ${error}`)
            return false
          }
          logger.info(`Applied patchs for model ${modelId}`)
          return true
        }
      }
    }

    return true
  }

  /**
   * Add a model to OVMS by downloading it
   * @param modelName Name of the model to add
   * @param modelId ID of the model to download
   * @param modelSource Model Source: huggingface, hf-mirror and modelscope, default is huggingface
   * @param task Task type: text_generation, embedding, rerank, image_generation
   */
  public async addModel(
    modelName: string,
    modelId: string,
    modelSource: string,
    task: string = 'text_generation'
  ): Promise<{ success: boolean; message?: string }> {
    // After shutdown, never start a download.
    if (this.stopped) {
      logger.warn('addModel refused: manager is stopped')
      return { success: false, message: 'OVMS manager is stopped' }
    }
    // Do not overwrite an in-flight download handle; a duplicate start would orphan it.
    if (this.downloadChild && !this.downloadChild.killed && this.downloadChild.exitCode === null) {
      logger.warn('A model download is already in progress')
      return { success: false, message: 'A model download is already in progress' }
    }
    logger.info(`Adding model: ${modelName} with ID: ${modelId}, Source: ${modelSource}, Task: ${task}`)

    const ovdndDir = application.getPath('feature.ovms.ovms')
    const modelsDir = path.join(ovdndDir, 'models')
    const pathModel = path.join(modelsDir, modelId)

    // Defense in depth: the schema already constrains modelId, but never let a
    // crafted id (e.g. `..`) escape the models directory into an arbitrary path
    // that the failure-cleanup fs.remove below would then delete.
    const modelsRoot = path.resolve(modelsDir)
    if (!path.resolve(pathModel).startsWith(modelsRoot + path.sep)) {
      logger.error(`Rejected model id outside models directory: ${modelId}`)
      return { success: false, message: 'Invalid model ID' }
    }

    try {
      // check the ovdnDir+'models'+modelId exist or not
      if (await fs.pathExists(pathModel)) {
        logger.error(`Model with ID ${modelId} already exists`)
        return { success: false, message: 'Model ID already exists!' }
      }

      // remove the model directory if it exists
      if (await fs.pathExists(pathModel)) {
        logger.info(`Removing existing model directory: ${pathModel}`)
        await fs.remove(pathModel)
      }

      // Use ovdnd.exe for downloading instead of ovms.exe. Pass every argument as
      // a distinct argv element (execFile runs with shell: false), so user-supplied
      // values can never be interpreted as shell syntax.
      const ovdndPath = path.join(ovdndDir, 'ovdnd.exe')
      const args = [
        '--pull',
        '--model_repository_path',
        modelsDir,
        '--source_model',
        modelId,
        '--model_name',
        modelName,
        '--target_device',
        'GPU',
        '--task',
        task,
        '--overwrite_models'
      ]

      const env: Record<string, string | undefined> = {
        ...process.env,
        OVMS_DIR: ovdndDir,
        PYTHONHOME: path.join(ovdndDir, 'python'),
        PATH: `${process.env.PATH};${ovdndDir};${path.join(ovdndDir, 'python')}`
      }

      if (modelSource) {
        env.HF_ENDPOINT = modelSource
      }

      logger.info(`Running ovdnd --pull for ${modelId} from ${modelSource}`)
      // const { stdout } = await execFileAsync(ovdndPath, args, { env, cwd: ovdndDir })  // old: no owned handle to cancel
      // Use the callback form (not bare execFile) so stdout/stderr are drained into buffers
      // (large model logs won't stall the child under the default 1MB maxBuffer), while still
      // giving us the `child` as an owned, stoppable handle for stopAddModel.
      await new Promise<void>((resolve, reject) => {
        const child = execFile(
          ovdndPath,
          args,
          { env, cwd: ovdndDir, maxBuffer: OvmsManager.MAX_DOWNLOAD_BUFFER },
          (error, _stdout, stderr) => {
            this.downloadChild = null
            if (error) {
              logger.error(`ovdnd failed: ${stderr || error.message}`)
              reject(error)
            } else {
              resolve()
            }
          }
        )
        this.downloadChild = child
      })
      logger.info('Model download completed')
    } catch (error) {
      // remove ovdnDir+'models'+modelId if it exists
      if (await fs.pathExists(pathModel)) {
        logger.info(`Removing failed model directory: ${pathModel}`)
        await fs.remove(pathModel)
      }
      logger.error(`Failed to add model: ${error}`)
      return {
        success: false,
        message: `Download model ${modelId} failed, please check following items and try it again:<p>- the model id</p><p>- network connection and proxy</p>`
      }
    }

    // Update config file
    if (!(await this.updateModelConfig(modelName, modelId))) {
      logger.error('Failed to update model config')
      return { success: false, message: 'Failed to update model config' }
    }

    if (!(await this.applyModelPath(pathModel))) {
      logger.error('Failed to apply model patchs')
      return { success: false, message: 'Failed to apply model patchs' }
    }

    logger.info(`Model ${modelName} added successfully with ID ${modelId}`)
    return { success: true }
  }

  /**
   * Stop the model download process if it's running
   * @returns Promise<{ success: boolean; message?: string }>
   */
  public async stopAddModel(): Promise<{ success: boolean; message?: string }> {
    // NOTE: the original implementation scanned `Get-Process -Name "ovdnd"` and killed ALL
    // ovdnd.exe instances (including ones we didn't start). The new version only stops the
    // download this app started. Original code:
    /*
    try {
      const psCommand = `Get-Process -Name "ovdnd" -ErrorAction SilentlyContinue | Select-Object Id, Path | ConvertTo-Json`
      const { stdout } = await execAsync(`powershell -Command "${psCommand}"`)
      if (!stdout.trim()) {
        logger.info('ovdnd process is not running')
        return { success: true, message: 'Model download process is not running' }
      }
      const processes = JSON.parse(stdout)
      const processList = Array.isArray(processes) ? processes : [processes]
      if (processList.length === 0) {
        logger.info('ovdnd process is not running')
        return { success: true, message: 'Model download process is not running' }
      }
      for (const process of processList) {
        void this.terminalProcess(process.Id)
      }
      logger.info('Model download process stopped successfully')
      return { success: true, message: 'Model download process stopped successfully' }
    } catch (error) {
      logger.error(`Failed to stop model download process: ${error}`)
      return { success: false, message: 'Failed to stop model download process' }
    }
    */
    // Only stop the download this app started; never scan-kill external ovdnd.exe.
    if (!this.downloadChild) {
      logger.info('No owned model download process to stop')
      return { success: true, message: 'Model download process is not running' }
    }
    const pid = this.downloadChild.pid ?? -1
    try {
      // const { stdout } = await execAsync(`powershell -Command "Get-Process -Name \"ovdnd\" ..."`)  // old: killed external downloads
      const result = await this.terminalProcess(pid)
      // Retain the owned handle on a non-clean stop (e.g. invalid PID) so we never lose it.
      if (result.success) {
        this.downloadChild = null
        logger.info('Model download process stopped successfully')
        return { success: true, message: 'Model download process stopped successfully' }
      }
      return result
    } catch (error) {
      logger.error(`Failed to stop model download process: ${error}`)
      return { success: false, message: 'Failed to stop model download process' }
    }
  }

  /**
   * check if the model id exists in the OVMS configuration
   * @param modelId ID of the model to check
   */
  public async checkModelExists(modelId: string): Promise<boolean> {
    const ovmsDir = application.getPath('feature.ovms.ovms')
    const configPath = path.join(ovmsDir, 'models', 'config.json')

    try {
      if (!(await fs.pathExists(configPath))) {
        logger.warn(`Config file does not exist: ${configPath}`)
        return false
      }

      const config: OvmsConfig = await fs.readJson(configPath)
      if (!config.mediapipe_config_list) {
        logger.warn('No mediapipe_config_list found in config')
        return false
      }

      return config.mediapipe_config_list.some((model) => model.base_path === modelId)
    } catch (error) {
      logger.error(`Failed to check model existence: ${error}`)
      return false
    }
  }

  /**
   * Update the model configuration file
   */
  public async updateModelConfig(modelName: string, modelId: string): Promise<boolean> {
    const ovmsDir = application.getPath('feature.ovms.ovms')
    const configPath = path.join(ovmsDir, 'models', 'config.json')

    try {
      // Ensure the models directory exists
      await fs.ensureDir(path.dirname(configPath))
      let config: OvmsConfig

      // Read existing config or create new one
      if (await fs.pathExists(configPath)) {
        config = await fs.readJson(configPath)
      } else {
        config = { mediapipe_config_list: [] }
      }

      // Ensure mediapipe_config_list exists
      if (!config.mediapipe_config_list) {
        config.mediapipe_config_list = []
      }

      // Add new model config
      const newModelConfig: ModelConfig = {
        name: modelName,
        base_path: modelId
      }

      // Check if model already exists, if so, update it
      const existingIndex = config.mediapipe_config_list.findIndex((model) => model.base_path === modelId)

      if (existingIndex >= 0) {
        config.mediapipe_config_list[existingIndex] = newModelConfig
        logger.info(`Updated existing model config: ${modelName}`)
      } else {
        config.mediapipe_config_list.push(newModelConfig)
        logger.info(`Added new model config: ${modelName}`)
      }

      // Write config back to file
      await fs.writeJson(configPath, config, { spaces: 2 })
      logger.info(`Config file updated: ${configPath}`)
    } catch (error) {
      logger.error(`Failed to update model config: ${error}`)
      return false
    }
    return true
  }

  /**
   * Get all models from OVMS config, filtered for image generation models
   * @returns Array of model configurations
   */
  public async getModels(): Promise<ModelConfig[]> {
    const ovmsDir = application.getPath('feature.ovms.ovms')
    const configPath = path.join(ovmsDir, 'models', 'config.json')

    try {
      if (!(await fs.pathExists(configPath))) {
        logger.warn(`Config file does not exist: ${configPath}`)
        return []
      }

      const config: OvmsConfig = await fs.readJson(configPath)
      if (!config.mediapipe_config_list) {
        logger.warn('No mediapipe_config_list found in config')
        return []
      }

      // Filter models for image generation (SD, Stable-Diffusion, Stable Diffusion, FLUX)
      const imageGenerationModels = config.mediapipe_config_list.filter((model) => {
        const modelName = model.name.toLowerCase()
        return (
          modelName.startsWith('sd') ||
          modelName.startsWith('stable-diffusion') ||
          modelName.startsWith('stable diffusion') ||
          modelName.startsWith('flux')
        )
      })

      logger.info(`Found ${imageGenerationModels.length} image generation models`)
      return imageGenerationModels
    } catch (error) {
      logger.error(`Failed to get models: ${error}`)
      return []
    }
  }
}
