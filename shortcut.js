'use strict';
/*
 * The "Send to Dropspace" shortcut for an iPhone or iPad's Share button.
 *
 * It's a tiny Shortcuts program: for each photo, video or file shared to it, post it to Dropspace,
 * then show "Sent to Dropspace". Each phone gets its own copy with its own key in the address.
 *
 * iPhones only open shortcuts signed by a Mac, so on a Mac Dropspace signs it with the built-in
 * `shortcuts sign` command. Everywhere else, the phone builds the same shortcut by hand from the
 * steps shown in Settings.
 */
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const SHORTCUTS_CLI = '/usr/bin/shortcuts';
const PLUTIL = '/usr/bin/plutil';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const uuid = () => crypto.randomUUID().toUpperCase();

/** A plain JavaScript value as XML property list markup. */
function plist(value, indent = '') {
  const next = indent + '  ';
  if (value === true) return `${indent}<true/>`;
  if (value === false) return `${indent}<false/>`;
  if (typeof value === 'number') return `${indent}<integer>${Math.trunc(value)}</integer>`;
  if (typeof value === 'string') return `${indent}<string>${esc(value)}</string>`;
  if (Array.isArray(value)) {
    if (!value.length) return `${indent}<array/>`;
    return `${indent}<array>\n${value.map((v) => plist(v, next)).join('\n')}\n${indent}</array>`;
  }
  const keys = Object.keys(value);
  if (!keys.length) return `${indent}<dict/>`;
  return `${indent}<dict>\n${keys.map((k) => `${next}<key>${esc(k)}</key>\n${plist(value[k], next)}`).join('\n')}\n${indent}</dict>`;
}

const textToken = (text) => ({ Value: { attachmentsByRange: {}, string: text }, WFSerializationType: 'WFTextTokenString' });
const variable = (attachment) => ({ Value: attachment, WFSerializationType: 'WFTextTokenAttachment' });

/** The shortcut, as an unsigned XML property list. `url` already includes this phone's key. */
function shortcutXml({ url }) {
  const group = uuid();
  const workflow = {
    WFQuickActionSurfaces: [],
    WFWorkflowActions: [
      {
        WFWorkflowActionIdentifier: 'is.workflow.actions.repeat.each',
        WFWorkflowActionParameters: {
          GroupingIdentifier: group,
          UUID: uuid(),
          WFControlFlowMode: 0,
          WFInput: variable({ Type: 'ExtensionInput' }),
        },
      },
      {
        WFWorkflowActionIdentifier: 'is.workflow.actions.downloadurl',
        WFWorkflowActionParameters: {
          ShowHeaders: false,
          UUID: uuid(),
          WFHTTPBodyType: 'Form',
          WFHTTPMethod: 'POST',
          WFURL: url,
          WFFormValues: {
            Value: {
              WFDictionaryFieldValueItems: [
                {
                  UUID: uuid(),
                  WFItemType: 5, // a file
                  WFKey: textToken('file'),
                  WFValue: {
                    Value: variable({ Type: 'Variable', VariableName: 'Repeat Item' }),
                    WFSerializationType: 'WFTokenAttachmentParameterState',
                  },
                },
              ],
            },
            WFSerializationType: 'WFDictionaryFieldValue',
          },
        },
      },
      {
        WFWorkflowActionIdentifier: 'is.workflow.actions.repeat.each',
        WFWorkflowActionParameters: { GroupingIdentifier: group, UUID: uuid(), WFControlFlowMode: 2 },
      },
      {
        WFWorkflowActionIdentifier: 'is.workflow.actions.notification',
        WFWorkflowActionParameters: {
          UUID: uuid(),
          WFNotificationActionBody: 'Sent to Dropspace',
          WFNotificationActionSound: false,
        },
      },
    ],
    WFWorkflowClientVersion: '1146.14',
    WFWorkflowHasOutputFallback: false,
    WFWorkflowHasShortcutInputVariables: true,
    WFWorkflowIcon: { WFWorkflowIconGlyphNumber: 59511, WFWorkflowIconStartColor: 4282601983 },
    WFWorkflowImportQuestions: [],
    // Photos, videos and files. Text and links are easier to paste into the page.
    WFWorkflowInputContentItemClasses: [
      'WFImageContentItem',
      'WFPhotoMediaContentItem',
      'WFAVAssetContentItem',
      'WFGenericFileContentItem',
      'WFPDFContentItem',
    ],
    WFWorkflowMinimumClientVersion: 900,
    WFWorkflowMinimumClientVersionString: '900',
    WFWorkflowOutputContentItemClasses: [],
    WFWorkflowTypes: ['ActionExtension'],
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
${plist(workflow)}
</plist>
`;
}

const canSign = () => process.platform === 'darwin' && fs.existsSync(SHORTCUTS_CLI);

function run(cmd, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout }, (err, _stdout, stderr) => (err ? reject(new Error(String(stderr || err.message).trim().split('\n').pop())) : resolve()));
  });
}

/** Sign the shortcut with this Mac's built-in tool. Resolves with the signed file, or null if this computer can't. */
async function signShortcut(xml) {
  if (!canSign()) return null;
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dropspace-shortcut-'));
  try {
    const input = path.join(dir, 'Send to Dropspace.shortcut');
    const output = path.join(dir, 'signed.shortcut');
    await fsp.writeFile(input, xml);
    if (fs.existsSync(PLUTIL)) await run(PLUTIL, ['-convert', 'binary1', input], 10000).catch(() => {});
    await run(SHORTCUTS_CLI, ['sign', '--mode', 'anyone', '--input', input, '--output', output], 60000);
    return await fsp.readFile(output);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { shortcutXml, signShortcut, canSign };
