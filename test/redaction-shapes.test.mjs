import test from "node:test";
import assert from "node:assert/strict";
import { redactSecrets } from "../lib/claude.mjs";

// Synthetic credential shapes, joined at runtime so the source holds no credential-shaped literal.
const R = "[secret removed]";
const PW = "Win" + "ter2026!x";
const SPACED = "Win" + "ter 2026 x";
const AT_PW = "p" + "@ss" + "Word9";
const TOKEN = "tk" + "Q7x" + "R2mV9pL";
const NPM = "npm" + "_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
const AWS = "wJalr" + "XUtnFEMI/K7MDENG+bPxRfi" + "CYzEXAMPLEKEY";
const SLACK = "XyZ" + "abc123DEF456ghi789";
const B64 = "YnVp" + "bGRlcjpXaW50ZXI=";
const SIG = "ctzMq410TV3wS7" + "upTBcunJTDLEJwMAZuFPfr0mrrA08=";

// Each line holds a credential; only the credential may change, and the rest must read exactly as before.
const LEAKS = [
  [`Invoke-Sqlcmd -ServerInstance db1 -Username sa -Password "${PW}" -Query "select 1"`,
    `Invoke-Sqlcmd -ServerInstance db1 -Username sa -Password "${R}" -Query "select 1"`],
  [`Invoke-Sqlcmd -Password '${SPACED}' -Query q`, `Invoke-Sqlcmd -Password '${R}' -Query q`],
  [`mysqldump --password "${SPACED}" shop`, `mysqldump --password "${R}" shop`],
  [`gh auth login --token "${TOKEN}"`, `gh auth login --token "${R}"`],
  [`wget --password=${PW} https://files.example.test/a.zip`, `wget --password=${R} https://files.example.test/a.zip`],
  [`docker login -u builder -p ${PW} registry.example.test`, `docker login -u builder -p ${R} registry.example.test`],
  [`docker login registry.example.test -u builder -p '${SPACED}'`, `docker login registry.example.test -u builder -p '${R}'`],
  [`podman login -u builder -p=${PW} quay.example.test`, `podman login -u builder -p=${R} quay.example.test`],
  [`sshpass -p ${PW} ssh deploy@build.local`, `sshpass -p ${R} ssh deploy@build.local`],
  [`sshpass -p "${SPACED}" scp a.txt deploy@build.local:/srv`, `sshpass -p "${R}" scp a.txt deploy@build.local:/srv`],
  [`sshpass -v -p${PW} ssh -p 2222 deploy@build.local`, `sshpass -v -p${R} ssh -p 2222 deploy@build.local`],
  [`mysql -u root -p${PW} shop`, `mysql -u root -p${R} shop`],
  [`mysql -u root -p'${SPACED}' shop`, `mysql -u root -p'${R}' shop`],
  [`sqlcmd -S db1 -U sa -P "${SPACED}" -Q "select 1"`, `sqlcmd -S db1 -U sa -P "${R}" -Q "select 1"`],
  [`$secure = ConvertTo-SecureString "${PW}" -AsPlainText -Force`, `$secure = ConvertTo-SecureString "${R}" -AsPlainText -Force`],
  [`ConvertTo-SecureString -String '${PW}' -AsPlainText -Force`, `ConvertTo-SecureString -String '${R}' -AsPlainText -Force`],
  [`ConvertTo-SecureString -AsPlainText -Force -String "${PW}"`, `ConvertTo-SecureString -AsPlainText -Force -String "${R}"`],
  [`"${PW}" | ConvertTo-SecureString -AsPlainText -Force`, `"${R}" | ConvertTo-SecureString -AsPlainText -Force`],
  [`$cred = [System.Net.NetworkCredential]::new("svc-build", "${PW}")`, `$cred = [System.Net.NetworkCredential]::new("svc-build", "${R}")`],
  [`New-Object System.Net.NetworkCredential("svc-build","${PW}")`, `New-Object System.Net.NetworkCredential("svc-build","${R}")`],
  [`var c = new NetworkCredential("svc-build", "${PW}", "CORP");`, `var c = new NetworkCredential("svc-build", "${R}", "CORP");`],
  [`New-Object Net.NetworkCredential -ArgumentList svc-build,${PW}`, `New-Object Net.NetworkCredential -ArgumentList svc-build,${R}`],
  [`$pw = "${PW}"`, `$pw = "${R}"`],
  [`$password='${PW}'`, `$password='${R}'`],
  [`$dbPass = '${SPACED}'`, `$dbPass = '${R}'`],
  [`$env:API_TOKEN = "${TOKEN}"`, `$env:API_TOKEN = "${R}"`],
  [`export API_TOKEN=${TOKEN}`, `export API_TOKEN=${R}`],
  [`set PASSWORD=${PW}`, `set PASSWORD=${R}`],
  [`set "ADMIN_PW=${PW}"`, `set "ADMIN_PW=${R}"`],
  [`DB_PASS=${PW} npm run migrate`, `DB_PASS=${R} npm run migrate`],
  [`openssl pkcs12 -export -in cert.pem -passout pass:${PW} -out cert.p12`, `openssl pkcs12 -export -in cert.pem -passout pass:${R} -out cert.p12`],
  [`openssl rsa -in key.pem -passin pass:${PW}`, `openssl rsa -in key.pem -passin pass:${R}`],
  [`openssl pkcs12 -in a.p12 -passin "pass:${SPACED}" -nodes`, `openssl pkcs12 -in a.p12 -passin "pass:${R}" -nodes`],
  [`aws configure set aws_secret_access_key ${AWS}`, `aws configure set aws_secret_access_key ${R}`],
  [`aws configure set aws_session_token ${AWS} --profile dev`, `aws configure set aws_session_token ${R} --profile dev`],
  [`npm config set //registry.npmjs.org/:_authToken ${NPM}`, `npm config set //registry.npmjs.org/:_authToken ${R}`],
  [`npm config set //npm.example.test/:_authToken=${NPM}`, `npm config set //npm.example.test/:_authToken=${R}`],
  [`echo ${NPM} > token.txt`, `echo ${R} > token.txt`],
  [`curl -X POST https://hooks.slack.com/services/T0AAAA/B0BBBB/${SLACK} -d @msg.json`, `curl -X POST https://hooks.slack.com/services/${R} -d @msg.json`],
  [`git clone https://builder:${PW}@git.example.test/shop.git`, `git clone https://builder:${R}@git.example.test/shop.git`],
  [`psql postgres://app:${AT_PW}@db.local:5432/shop`, `psql postgres://app:${R}@db.local:5432/shop`],
  [`Server=db1;Database=shop;User Id=sa;Password=${PW};Encrypt=true`, `Server=db1;Database=shop;User Id=sa;Password=${R};Encrypt=true`],
  [`Data Source=db1;Initial Catalog=shop;Uid=app;Pwd=${SPACED};`, `Data Source=db1;Initial Catalog=shop;Uid=app;Pwd=${R};`],
  [`Password=${SPACED};Server=db1`, `Password=${R};Server=db1`],
  [`curl -H "Authorization: token ${TOKEN}" https://api.example.test`, `curl -H "Authorization: token ${R}" https://api.example.test`],
  [`curl -H 'Authorization: Bearer ${TOKEN}' https://api.example.test`, `curl -H 'Authorization: Bearer ${R}' https://api.example.test`],
  [`Authorization: Basic ${B64}`, `Authorization: Basic ${R}`],
  [`Authorization: SharedKey shopstore:${SIG}`, `Authorization: SharedKey shopstore:${R}`],
  [`{"Authorization": "Bearer ${TOKEN}"}`, `{"Authorization": "Bearer ${R}"}`],
  [`Proxy-Authorization: Basic ${B64}`, `Proxy-Authorization: Basic ${R}`],
  [`curl -H "Authorization: ${TOKEN}" https://api.example.test`, `curl -H "Authorization: ${R}" https://api.example.test`],
  [`{\\"Authorization\\":\\"Bearer ${TOKEN}\\"}`, `{\\"Authorization\\":\\"Bearer ${R}\\"}`],
  [`?sv=2022-11-02&token=${TOKEN}&expires=1`, `?sv=2022-11-02&token=${R}&expires=1`],
  // Key names that end in "key" or "pass".
  [`secret_key = "${PW}"`, `secret_key = "${R}"`],
  [`{"secret_key": "${PW}", "region": "us-east-1"}`, `{"secret_key": "${R}", "region": "us-east-1"}`],
  [`secretKey: ${PW}`, `secretKey: ${R}`],
  [`signing_key=${PW}`, `signing_key=${R}`],
  [`encryption_key: '${SPACED}'`, `encryption_key: '${R}'`],
  [`client_key = ${PW}`, `client_key = ${R}`],
  [`master_key=${PW}`, `master_key=${R}`],
  [`db_pass=${PW}`, `db_pass=${R}`],
  [`DB_PASS: ${PW}`, `DB_PASS: ${R}`],
  [`smtpPass = "${PW}"`, `smtpPass = "${R}"`],
  [`passcode: ${PW}`, `passcode: ${R}`],
  [`{"user": "builder", "pass": "${PW}"}`, `{"user": "builder", "pass": "${R}"}`],
  [`curl -H "Ocp-Apim-Subscription-Key: ${TOKEN}" https://api.example.test`, `curl -H "Ocp-Apim-Subscription-Key: ${R}" https://api.example.test`],
  // Authorization with any scheme: the scheme stays, the credential goes.
  [`curl -H "Authorization: Bot ${TOKEN}" https://chat.example.test`, `curl -H "Authorization: Bot ${R}" https://chat.example.test`],
  [`Authorization: OAuth ${TOKEN}`, `Authorization: OAuth ${R}`],
  [`Authorization: AWS AKIDEXAMPLE:${SIG}`, `Authorization: AWS ${R}`],
  [`Authorization: Bearer: ${TOKEN}`, `Authorization: Bearer: ${R}`],
  [`Authorization: OAuth oauth_consumer_key="shop", oauth_signature="${SIG}"`, `Authorization: OAuth ${R}`],
  // ConvertTo-SecureString with its switches first.
  [`$secure = ConvertTo-SecureString -AsPlainText -Force "${PW}"`, `$secure = ConvertTo-SecureString -AsPlainText -Force "${R}"`],
  [`ConvertTo-SecureString -AsPlainText "${PW}" -Force`, `ConvertTo-SecureString -AsPlainText "${R}" -Force`],
  // Environment variables set without "=".
  [`setx API_TOKEN "${TOKEN}"`, `setx API_TOKEN "${R}"`],
  [`setx DB_PASSWORD ${PW} /M`, `setx DB_PASSWORD ${R} /M`],
  [`[Environment]::SetEnvironmentVariable("API_TOKEN","${TOKEN}")`, `[Environment]::SetEnvironmentVariable("API_TOKEN","${R}")`],
  [`[System.Environment]::SetEnvironmentVariable('DB_PASSWORD', '${PW}', 'User')`, `[System.Environment]::SetEnvironmentVariable('DB_PASSWORD', '${R}', 'User')`],
  [`os.environ["API_TOKEN"]="${TOKEN}"`, `os.environ["API_TOKEN"]="${R}"`],
  [`os.environ['DB_PASS'] = '${PW}'`, `os.environ['DB_PASS'] = '${R}'`],
  // A password attached to its flag, in parentheses, or with PowerShell's escaped quotes.
  [`sqlcmd -S db1 -U sa -P${PW} -Q "select 1"`, `sqlcmd -S db1 -U sa -P${R} -Q "select 1"`],
  [`Invoke-Sqlcmd -ServerInstance db1 -Password ("${PW}")`, `Invoke-Sqlcmd -ServerInstance db1 -Password ("${R}")`],
  [`Invoke-Sqlcmd -Password "x\`"${PW}" -Query q`, `Invoke-Sqlcmd -Password "${R}" -Query q`],
  [`$pw = "x\`"${PW}"`, `$pw = "${R}"`],
  // Password flags of tools where the short flag is the password.
  [`az login -u builder@example.test -p ${PW}`, `az login -u builder@example.test -p ${R}`],
  [`keytool -genkey -keystore shop.jks -storepass ${PW} -keypass ${PW}`, `keytool -genkey -keystore shop.jks -storepass ${R} -keypass ${R}`],
  [`jarsigner -keystore shop.jks -storepass ${PW} app.jar shop`, `jarsigner -keystore shop.jks -storepass ${R} app.jar shop`],
  [`cmdkey /generic:shop /user:builder /pass:${PW}`, `cmdkey /generic:shop /user:builder /pass:${R}`],
  [`net use Z: \\\\files.example.test\\share ${PW} /user:CORP\\builder`, `net use Z: \\\\files.example.test\\share ${R} /user:CORP\\builder`],
  [`psexec \\\\build01 -u CORP\\builder -p ${PW} cmd`, `psexec \\\\build01 -u CORP\\builder -p ${R} cmd`],
  [`7z a -p${PW} backup.7z docs`, `7z a -p${R} backup.7z docs`],
  [`zip -P ${PW} backup.zip docs/*`, `zip -P ${R} backup.zip docs/*`],
  [`redis-cli -h cache.local -p 6379 -a ${PW} ping`, `redis-cli -h cache.local -p 6379 -a ${R} ping`],
  [`mongosh "mongodb://db.local" -u admin -p ${PW}`, `mongosh "mongodb://db.local" -u admin -p ${R}`],
  [`ldapsearch -x -H ldap://dir.local -D "cn=admin" -w ${PW} -b dc=shop`, `ldapsearch -x -H ldap://dir.local -D "cn=admin" -w ${R} -b dc=shop`],
  [`smbclient //files.example.test/share -U builder%${PW}`, `smbclient //files.example.test/share -U builder%${R}`],
  [`schtasks /create /tn Backup /tr backup.cmd /ru CORP\\builder /rp ${PW}`, `schtasks /create /tn Backup /tr backup.cmd /ru CORP\\builder /rp ${R}`],
  [`openssl enc -aes-256-cbc -in a.txt -out a.enc -k ${PW}`, `openssl enc -aes-256-cbc -in a.txt -out a.enc -k ${R}`],
];

// Lines that only look like credentials: none may change.
const PLAIN = [
  "sqlcmd -S db1 -PacketSize 4096 -Q \"select 1\"",
  "Invoke-Sqlcmd -ServerInstance db1 -Password $pw -Query \"select 1\"",
  "gh auth login --token \"$GH_TOKEN\"",
  "docker run -p 8080:80 shop-web",
  "docker login -u builder --password-stdin registry.example.test",
  "ssh -p 2222 deploy@build.local",
  "sshpass -f pw.txt ssh -p 2222 deploy@build.local",
  "if (password == null) return;",
  "pytest -p no:cacheprovider tests/",
  "mysql -p shop",
  "rsync -P src/ dest/",
  "git push -u origin main",
  "curl -u admin https://api.example.test",
  "$password = Read-Host -AsSecureString",
  "$secure = ConvertTo-SecureString $plain -AsPlainText -Force",
  "$cred = Get-Credential",
  "New-Object System.Net.NetworkCredential(\"svc-build\", $secure)",
  "var c = new NetworkCredential(user, password);",
  "$bypass = \"yes\"",
  "$passes = 3",
  "$pass = 0",
  "$env:PASSWORD_FILE = \"C:\\work\\pw.txt\"",
  "export PATH=/usr/local/bin:$PATH",
  "set DEBUG=1",
  "openssl pkcs12 -in a.p12 -passin env:P12_PASS -out a.pem",
  "openssl req -new -passout file:pw.txt -out req.csr",
  "aws configure set region us-east-1",
  "npm config set registry https://registry.npmjs.org/",
  "https://hooks.example.test/services/abc",
  "git clone https://builder@git.example.test/shop.git",
  "git clone https://builder:$GIT_TOKEN@git.example.test/shop.git",
  "https://shop.example.test:8443/api/login",
  "Server=db1;Database=shop;Integrated Security=true;",
  "The Authorization header is missing.",
  "curl -H \"Authorization: Bearer $TOKEN\" https://api.example.test",
  "Uses Basic authentication over TLS.",
  "Send a Bearer token in the header.",
  "merged 3f786850e387550fdab836ed7e6dc881de23001b",
  "sha256 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "Set max_tokens: 4096 and token_count = 12.",
  "The password is incorrect.",
  "pwd && ls -la",
  "npm test -- --runInBand",
  "kubectl create secret generic shop --from-file=./tls.crt",
  // Look-alikes of the newer shapes: ports, prompts, names, and words that only end like a key or a pass.
  "redis-cli -h cache.local -p 6379 ping",
  "ldapsearch -x -H ldap://dir.local -p 389 -b dc=shop",
  "mongosh --port 27017 -u admin -p",
  "npm ls -p --depth 0",
  "psexec \\\\build01 -s -i cmd",
  "7z x backup.7z -oout",
  "zip -r backup.zip docs",
  "net use Z: \\\\files.example.test\\share /user:CORP\\builder",
  "net use Z: \\\\files.example.test\\share * /user:CORP\\builder",
  "cmdkey /list",
  "keytool -list -keystore shop.jks -storepass:env STORE_PW",
  "schtasks /query /fo LIST /v",
  "openssl rand -hex 32",
  "smbclient //files.example.test/share -U builder",
  "az login --use-device-code",
  "setx PATH \"%PATH%;C:\\tools\"",
  "setx DEBUG 1",
  "os.environ[\"HOME\"] = \"/home/dev\"",
  "[Environment]::SetEnvironmentVariable(\"PATH\", $path, \"User\")",
  "$secure = ConvertTo-SecureString -AsPlainText -Force $plain",
  "Invoke-Sqlcmd -ServerInstance db1 -Password (Get-Secret dbpw)",
  "primary_key: id",
  "sort_key = \"created_at\"",
  "public_key: ./keys/deploy.pub",
  "bypass: true",
  "\"bypass\": \"yes\"",
  "compass: north",
  "pass: 42",
  "client_key: ./certs/client.key",
  "private_key = \"/etc/ssl/private/shop.key\"",
  "session_key = created_at",
  "cp backup.zip -P dest/",
  "openssl s_client -connect shop.example.test:443 -pass env:P12_PASS",
  "Authorization: Bearer $TOKEN",
];

test("every recognised credential shape loses its value, and only its value", () => {
  assert.ok(LEAKS.length + PLAIN.length >= 40);
  for (const [text, expected] of LEAKS) {
    const redacted = redactSecrets(text);
    assert.equal(redacted, expected, text);
    for (const secret of [PW, SPACED, AT_PW, TOKEN, NPM, AWS, SLACK, B64, SIG]) assert.ok(!redacted.includes(secret), `${text} -> ${redacted}`);
  }
});

test("text that only looks like a credential is left exactly as it was", () => {
  const changed = PLAIN.map((text) => [text, redactSecrets(text)]).filter(([text, redacted]) => text !== redacted);
  assert.deepEqual(changed, []);
});

test("the new shapes stay linear on hostile text", () => {
  const started = Date.now();
  for (const piece of ["password=", ";Password=a ", "$pw=", "Authorization: Bearer ", "docker login -p ", "ConvertTo-SecureString ",
    "NetworkCredential(", "https://u:", "//r/:_authToken ", "A_B "]) redactSecrets(piece.repeat(20_000));
  assert.ok(Date.now() - started < 4000, `took ${Date.now() - started} ms`);
});
