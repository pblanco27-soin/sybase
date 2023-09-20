const spawn = require("child_process").spawn;
const JSONStream = require("JSONStream");
const path = require("path");

function Sybase({
  host,
  port,
  database,
  username,
  password,
  logTiming,
  pathToJavaBridge,
  encoding = "utf8",
  logs = false,
}) {
  this.connected = false;
  this.host = host;
  this.port = port;
  this.database = database;
  this.username = username;
  this.password = password;
  this.logTiming = logTiming === true;
  this.encoding = encoding;
  this.logs = logs;

  this.pathToJavaBridge = pathToJavaBridge;

  if (this.pathToJavaBridge === undefined) {
    this.pathToJavaBridge = path.resolve(
      __dirname,
      "..",
      "JavaSybaseLink",
      "JavaSybaseLink.jar"
    );
  }

  this.queryCount = 0;
  this.currentMessages = { cat: 1 }; // look up msgId to message sent and call back details.

  this.jsonParser = JSONStream.parse();

  /**
   * Handles the SQL response from the database.
   *
   * @param {Object} jsonMsg - The JSON message received from the database.
   *
   * @example
   * this.onSQLResponse({
   *   msgId: 1,
   *   result: [...],
   *   javaStartTime: 1633027200000,
   *   javaEndTime: 1633027201000,
   *   error: undefined
   * });
   */
  const onSQLResponse = function (jsonMsg) {
    let err = null;

    const request = this.currentMessages[jsonMsg.msgId];
    delete this.currentMessages[jsonMsg.msgId];

    let result = jsonMsg.result;
    if (result.length === 1) {
      result = result[0]; // if there is only one just return the first RS not a set of RS's
    }

    const currentTime = new Date().getTime();
    const sendTimeMS = currentTime - jsonMsg.javaEndTime;
    const hrend = process.hrtime(request.hrstart);
    const javaDuration = jsonMsg.javaEndTime - jsonMsg.javaStartTime;

    if (jsonMsg.error !== undefined) {
      err = new Error(jsonMsg.error);
    }

    if (this.logTiming) {
      this.log(
        "Execution time (hr): %ds %dms dbTime: %dms dbSendTime: %d sql=%s",
        hrend[0],
        hrend[1] / 1000000,
        javaDuration,
        sendTimeMS,
        request.sql
      );
    }

    request.callback(err, result);
  }.bind(this);

  /**
   * Handles SQL errors from the database.
   *
   * @param {string|Object} data - The error data received from the database.
   *
   * @example
   * this.onSQLError("Some SQL error message");
   */
  const onSQLError = function (data) {
    const error = new Error(data);

    const callBackFuncitons = [];
    for (const k in this.currentMessages) {
      if (this.currentMessages.hasOwnProperty(k)) {
        callBackFuncitons.push(this.currentMessages[k].callback);
      }
    }

    this.currentMessages = [];
    callBackFuncitons.forEach(function (cb) {
      cb(error);
    });
  }.bind(this);

  const connectCore = function(callback) {
    this.javaDB = spawn('java', ['-jar', this.pathToJavaBridge, this.host, this.port, this.database, this.username, this.password]);
  
    this.javaDB.stdout.once('data', (data) => {
      const dataStr = data.toString().trim();  // Convert Buffer to string and trim it
      if (dataStr !== 'connected') {
        callback(new Error(`Error connecting ${dataStr}`), null);
        return;
      }
  
      this.javaDB.stderr.removeAllListeners('data');
      this.connected = true;
  
      this.javaDB.stdout.setEncoding(this.encoding).pipe(this.jsonParser).on('data', (jsonMsg) => { onSQLResponse(jsonMsg); });
      this.javaDB.stderr.on('data', (err) => { onSQLError(err); });
  
      callback(null, dataStr);
    });
  
    this.javaDB.stderr.once('data', (data) => {
      this.javaDB.stdout.removeAllListeners('data');
      this.javaDB.kill();
      callback(new Error(data.toString()), null);  // Convert Buffer to string
    });
  }.bind(this);

  this.connect = function (callback) {
    connectCore(callback);
  };

  this.connectAsync = function () {
    return new Promise((resolve, reject) => {
      connectCore((err, data) => {
        if (err) {
          reject(err);
        } else {
          resolve(data);
        }
      });
    });
  };

  const prepareQuery = function (sql, callback) {
    if (!this.isConnected()) {
      if (callback) callback(new Error("Database isn't connected."));

      return null;
    }

    const hrstart = process.hrtime();
    this.queryCount++;

    const msg = {
      msgId: this.queryCount,
      sql: sql,
      sentTime: new Date().getTime(),
      callback: callback,
      hrstart: hrstart,
    };

    const strMsg = JSON.stringify(msg).replace(/[\n]/g, "\\n");

    this.log(
      `this: ${this} currentMessages: ${this.currentMessages} this.queryCount: ${this.queryCount}`
    );

    this.currentMessages[msg.msgId] = msg;

    return strMsg;
  }.bind(this);

  /**
   * Executes a SQL query asynchronously and returns the result via a callback.
   *
   * @param {string} sql - The SQL query to execute.
   * @param {function} callback - The callback function to execute once the query is done.
   *
   * @example
   * const sybase = new Sybase(...);
   * sybase.query('SELECT * FROM users', (err, result) => {
   *   if (err) {
   *     console.error(err);
   *     return;
   *   }
   *   console.log(result);
   * });
   */
  this.query = function (sql, callback) {
    const strMsg = prepareQuery(sql, callback);
    if (strMsg === null) return;

    this.javaDB.stdin.write(strMsg + "\n");
    this.log(`SQL request written: ${strMsg}`);
  };

  /**
   * Executes a SQL query synchronously and returns the result.
   *
   * @param {string} sql - The SQL query to execute.
   * @returns {Object} The result of the query.
   *
   * @example
   * const sybase = new Sybase(...);
   * try {
   *   const result = sybase.querySync('SELECT * FROM users');
   *   console.log(result);
   * } catch (err) {
   *   console.error(err);
   * }
   */
  this.querySync = function (sql) {
    return new Promise((resolve, reject) => {
      const strMsg = prepareQuery(sql, null);
      if (strMsg === null) {
        reject(new Error("Database isn't connected."));
        return;
      }

      const onResponse = (jsonMsg) => {
        if (jsonMsg.msgId === this.queryCount) {
          this.jsonParser.removeListener("data", onResponse);
          if (jsonMsg.error !== undefined) reject(new Error(jsonMsg.error));
          else resolve(jsonMsg.result);
        }
      };

      this.jsonParser.on("data", onResponse);

      this.javaDB.stdin.write(strMsg + "\n");
      this.log(`SQL request written: ${strMsg}`);
    });
  };

  /**
   * Disconnects from the database and kills the Java process.
   *
   * @example
   * const sybase = new Sybase(...);
   * sybase.disconnect();
   */
  this.disconnect = function () {
    this.javaDB.kill();
    this.connected = false;
  };

  /**
   * Checks if the database is connected.
   *
   * @returns {boolean} True if connected, false otherwise.
   *
   * @example
   * const sybase = new Sybase(...);
   * const isConnected = sybase.isConnected();
   * console.log(`Is connected: ${isConnected}`);
   */
  this.isConnected = function () {
    return this.connected;
  };

  /**
   * Logs a message to the console if logs is enabled.
   *
   * @param {string} msg - The message to log.
   *
   * @example
   * const sybase = new Sybase(...);
   * sybase.log('This is a log message.');
   */
  this.log = function (msg) {
    if (this.logs) {
      console.log(msg);
    }
  };
}

module.exports = Sybase;