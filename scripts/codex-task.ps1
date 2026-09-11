# Ask Codex (GPT-5.6-Luna, max reasoning) to do one self-contained task.
#
# The parent agent's own subagent tool cannot choose a model or provider: its
# signature exposes only description/prompt/run_in_background, and a DSH
# subagent provider row fixes its model per instance and needs a profile restart
# to change. This script is the working alternative — it drives the Codex CLI
# directly, so model and reasoning effort are explicit here.
#
# Defaults mirror the user's ~/.codex/config.toml (model = gpt-5.6-luna,
# model_reasoning_effort = max). They are passed explicitly anyway so this
# script's behaviour does not change silently when that file changes.
#
# Usage:
#   .\scripts\codex-task.ps1 -PromptFile .\task.md
#   "short prompt" | .\scripts\codex-task.ps1 -ReadOnly
#
# -ReadOnly   forces the codex sandbox to read-only, for a task that must only
#             report and never edit. Default is workspace-write.
#
# For a file capture of the final message, call `codex exec -o <file>` directly.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $false, Position = 0)]
  [string]$PromptFile,

  [string]$Prompt,

  [string]$WorkDir = (Join-Path $PSScriptRoot '..'),

  [string]$Model = 'gpt-5.6-luna',

  [string]$ReasoningEffort = 'max',

  [switch]$ReadOnly,

  # Accepts the prompt from the pipeline. Declared explicitly because an
  # advanced script refuses pipeline input with no matching parameter.
  [Parameter(ValueFromPipeline = $true)]
  [string[]]$InputText
)

begin {
  $ErrorActionPreference = 'Stop'

  # Pipeline input arrives as $input, and the process block below is what lets
  # PowerShell bind piped text to this script at all; reading [Console]::In
  # directly does not work when the caller pipes.
  $pipedLines = [System.Collections.Generic.List[string]]::new()

  $sandbox = if ($ReadOnly) { 'read-only' } else { 'workspace-write' }
  $resolved = (Resolve-Path -Path $WorkDir).Path
}

process {
  if ($null -ne $InputText) { $pipedLines.AddRange($InputText) }
}

end {
  $text = if ($PromptFile) {
    if (-not (Test-Path $PromptFile)) { throw "prompt file not found: $PromptFile" }
    Get-Content -Path $PromptFile -Raw -Encoding UTF8
  } elseif ($pipedLines.Count -gt 0) {
    $pipedLines -join [Environment]::NewLine
  } elseif ($Prompt) {
    $Prompt
  } else {
    throw 'no prompt supplied: pass -PromptFile, -Prompt, or pipe text on stdin'
  }

  # `codex exec` reads the prompt from stdin when given no positional prompt,
  # which avoids every quoting problem with multi-line and non-ASCII text.
  $text | & codex exec `
    -C $resolved `
    -m $Model `
    -c "model_reasoning_effort=$ReasoningEffort" `
    -s $sandbox `
    --skip-git-repo-check

  exit $LASTEXITCODE
}
