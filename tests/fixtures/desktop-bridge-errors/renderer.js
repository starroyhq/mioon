import {readProjectEntryDesktopClient} from '../../../apps/web/src/project-entry-desktop-client.ts';
import {readProjectMediaNativeClient} from '../../../apps/web/src/project-media-native-client.ts';

const page = window;
const entry = readProjectEntryDesktopClient(window);
const media = readProjectMediaNativeClient(window);
if (!entry || !media || page.__mioonDesktop !== true) throw new Error('FIXTURE_BRIDGE_MISSING');

// Inspect errors inside the page: returning an Error through executeJavaScript
// would introduce a second serialization boundary and hide the actual result.
const snapshot = value => ({
  isError: value instanceof Error,
  code: value?.code ?? null,
  status: value?.status ?? null,
  details: value?.details ?? null,
  outcomeUnknown: value?.outcomeUnknown ?? null,
  keys: Object.keys(value ?? {}).sort(),
  message: value?.message ?? null,
});
const capture = async run => {
  try {return {resolved: true, value: await run()};}
  catch (error) {return {resolved: false, error: snapshot(error)};}
};
const invoke = (target, method, input) =>
  input === undefined ? target[method]() : target[method](input);

page.desktopBridgeErrors = {
  ready: true,
  async pair(kind, method, input) {
    const raw = kind === 'entry' ? page.__mioonProjectEntries : page.__mioonAssetMediaNative;
    const client = kind === 'entry' ? entry : media;
    return {
      raw: await capture(() => invoke(raw, method, input)),
      client: await capture(() => invoke(client, method, input)),
    };
  },
  call(method, input) {return invoke(entry, method, input);},
  startBlockedChoice() {
    page.blockedChoice = capture(() => entry.chooseLocation({purpose: 'duplicate', suggestedName: 'Fixture project', message: 'Fixture location'}));
  },
  finishBlockedChoice() {return page.blockedChoice;},
};
