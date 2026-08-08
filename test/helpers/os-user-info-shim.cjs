/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const os = require("node:os");

if (process.platform === "win32") {
  let userInfo;
  try {
    userInfo = os.userInfo();
  } catch {
    userInfo = {
      uid: -1,
      gid: -1,
      username: process.env.USERNAME ?? "myagent-test",
      homedir: process.env.USERPROFILE ?? os.homedir(),
      shell: null,
    };
  }
  os.userInfo = () => userInfo;
}
