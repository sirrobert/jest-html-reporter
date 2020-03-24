import { AggregatedResult } from "@jest/test-result";
import dateformat from "dateformat";
import fs from "fs";
import mkdirp from "mkdirp";
import path from "path";
import {
  IJestHTMLReporterConfig,
  IJestHTMLReporterConfigOptions,
  IJestHTMLReporterConsole,
  JestHTMLReporterSortType
} from "src/types";
import stripAnsi from "strip-ansi";
import xmlbuilder, { XMLElement } from "xmlbuilder";

import sorting from "./sorting";

class HTMLReporter {
  public testData: AggregatedResult;
  public consoleLogList: IJestHTMLReporterConsole[];
  private config: IJestHTMLReporterConfig;

  constructor(
    testData: AggregatedResult,
    options: IJestHTMLReporterConfigOptions,
    consoleLogs?: IJestHTMLReporterConsole[]
  ) {
    this.testData = testData;
    this.consoleLogList = consoleLogs;
    this.setupConfig(options);
  }

  public async generate() {
    try {
      const report = await this.renderTestReport();
      const outputPath = this.getConfigValue("outputPath") as string;

      await mkdirp(path.dirname(outputPath));
      if (this.getConfigValue("append") as boolean) {
        await fs.appendFileSync(outputPath, report);
      } else {
        await fs.writeFileSync(outputPath, report);
      }

      this.logMessage("success", `Report generated (${outputPath})`);
      return report;
    } catch (e) {
      this.logMessage("error", e);
    }
  }

  public async renderTestReport() {
    // Generate the content of the test report
    const reportContent = await this.renderTestReportContent();

    // --

    // Boilerplate Option
    if (!!this.getConfigValue("boilerplate")) {
      const boilerplateContent = await fs.readFileSync(
        this.getConfigValue("boilerplate") as string,
        "utf8"
      );
      return boilerplateContent.replace(
        "{jesthtmlreporter-content}",
        reportContent.toString()
      );
    }

    // --

    // Create HTML and apply reporter content
    const HTMLBase = {
      html: {
        head: {
          meta: { "@charset": "utf-8" },
          title: { "#text": this.getConfigValue("pageTitle") },
          style: undefined as object,
          link: undefined as object
        }
      }
    };
    // Default to the currently set theme
    let stylesheetFilePath: string = path.join(
      __dirname,
      `../style/${this.getConfigValue("theme")}.css`
    );
    // Overriding stylesheet
    if (this.getConfigValue("styleOverridePath")) {
      stylesheetFilePath = this.getConfigValue("styleOverridePath") as string;
    }
    // Decide whether to inline the CSS or not
    const inlineCSS: boolean =
      !this.getConfigValue("useCssFile") &&
      !!!this.getConfigValue("styleOverridePath");

    if (inlineCSS) {
      const stylesheetContent = await fs.readFileSync(
        stylesheetFilePath,
        "utf8"
      );
      HTMLBase.html.head.style = {
        "@type": "text/css",
        "#text": stylesheetContent
      };
    } else {
      HTMLBase.html.head.link = {
        "@rel": "stylesheet",
        "@type": "text/css",
        "@href": stylesheetFilePath
      };
    }
    const report = xmlbuilder.create(HTMLBase);
    const reportBody = report.ele("body");
    // Add the test report to the body
    reportBody.raw(reportContent.toString());
    // Add any given custom script to the end of the body
    if (!!this.getConfigValue("customScriptPath")) {
      reportBody.raw(
        `<script src="${this.getConfigValue("customScriptPath")}"></script>`
      );
    }
    return report;
  }

  public async renderTestReportContent() {
    try {
      if (!this.testData || Object.entries(this.testData).length === 0) {
        throw Error("No test data provided");
      }

      // HTML Body
      const reportBody: XMLElement = xmlbuilder.begin().element("div", {
        id: "jesthtml-content"
      });

      /**
       * Page Header
       */
      const header = reportBody.ele("header");
      // Page Title
      header.ele("h1", { id: "title" }, this.getConfigValue("pageTitle"));

      // Logo
      const logo = this.getConfigValue("logo");
      if (logo) {
        header.ele("img", { id: "logo", src: logo });
      }

      /**
       * Meta-Data
       */
      const metaDataContainer = reportBody.ele("div", {
        id: "metadata-container"
      });
      // Timestamp
      const timestamp = new Date(this.testData.startTime);
      metaDataContainer.ele(
        "div",
        { id: "timestamp" },
        `Start: ${dateformat(
          timestamp.toDateString(),
          this.getConfigValue("dateFormat") as string
        )}`
      );
      // Suite Summary
      metaDataContainer.ele(
        "div",
        { id: "suite-summary" },
        `${this.testData.numTotalTestSuites} suites -- ${this.testData.numPassedTestSuites} passed / ${this.testData.numFailedTestSuites} failed / ${this.testData.numPassedTestSuites} pending`
      );
      // Test Summary
      metaDataContainer.ele(
        "div",
        { id: "summary" },
        `${this.testData.numTotalTests} tests -- ${this.testData.numPassedTests} passed / ${this.testData.numFailedTests} failed / ${this.testData.numPendingTests} pending`
      );

      /**
       * Apply any given sorting method to the test results
       */
      const sortedTestResults = sorting(
        this.testData.testResults,
        this.getConfigValue("sort") as JestHTMLReporterSortType
      );

      /**
       * Setup ignored test result statuses
       */
      const statusIgnoreFilter = this.getConfigValue(
        "statusIgnoreFilter"
      ) as string;
      let ignoredStatuses: string[] = [];
      if (statusIgnoreFilter) {
        ignoredStatuses = statusIgnoreFilter
          .replace(/\s/g, "")
          .toLowerCase()
          .split(",");
      }

      /**
       * Test Suites
       */
      sortedTestResults.map(suite => {
        // Ignore this suite if there are no results
        if (!suite.testResults || suite.testResults.length <= 0) {
          return;
        }

        // Suite Information
        const suiteInfo = reportBody.ele("div", { class: "suite-info" });
        // Suite Path
        suiteInfo.ele("div", { class: "suite-path" }, suite.testFilePath);
        // Suite execution time
        const executionTime =
          (suite.perfStats.end - suite.perfStats.start) / 1000;
        suiteInfo.ele(
          "div",
          {
            class: `suite-time${
              executionTime >
              (this.getConfigValue("executionTimeWarningThreshold") as number)
                ? " warn"
                : ""
            }`
          },
          `${executionTime}s`
        );

        // Suite Test Table
        const suiteTable = reportBody.ele("table", {
          class: "suite-table",
          cellspacing: "0",
          cellpadding: "0"
        });
        // Test Results
        suite.testResults
          // Filter out the test results with statuses that equals the statusIgnoreFilter
          .filter(s => !ignoredStatuses.includes(s.status))
          .forEach(test => {
            const testTr = suiteTable.ele("tr", { class: test.status });
            // Suite Name(s)
            testTr.ele(
              "td",
              { class: "suite" },
              test.ancestorTitles.join(" > ")
            );
            // Test name
            const testTitleTd = testTr.ele("td", { class: "test" }, test.title);
            // Test Failure Messages
            if (
              test.failureMessages &&
              this.getConfigValue("includeFailureMsg")
            ) {
              const failureMsgDiv = testTitleTd.ele("div", {
                class: "failureMessages"
              });
              test.failureMessages.forEach(failureMsg => {
                failureMsgDiv.ele(
                  "pre",
                  { class: "failureMsg" },
                  stripAnsi(failureMsg)
                );
              });
            }
            // Append data to <tr>
            testTr.ele(
              "td",
              { class: "result" },
              test.status === "passed"
                ? `${test.status} in ${test.duration / 1000}s`
                : test.status
            );
          });

        // All console.logs caught during the test run
        if (
          this.consoleLogList &&
          this.consoleLogList.length > 0 &&
          this.getConfigValue("includeConsoleLog")
        ) {
          // Filter out the logs for this test file path
          const filteredConsoleLogs = this.consoleLogList.find(
            logs => logs.filePath === suite.testFilePath
          );
          if (filteredConsoleLogs && filteredConsoleLogs.logs.length > 0) {
            // Console Log Container
            const consoleLogContainer = reportBody.ele("div", {
              class: "suite-consolelog"
            });
            // Console Log Header
            consoleLogContainer.ele(
              "div",
              { class: "suite-consolelog-header" },
              "Console Log"
            );
            // Apply the logs to the body
            filteredConsoleLogs.logs.forEach(log => {
              const logElement = consoleLogContainer.ele("div", {
                class: "suite-consolelog-item"
              });
              logElement.ele(
                "pre",
                { class: "suite-consolelog-item-origin" },
                stripAnsi(log.origin)
              );
              logElement.ele(
                "pre",
                { class: "suite-consolelog-item-message" },
                stripAnsi(log.message)
              );
            });
          }
        }
      });

      return reportBody;
    } catch (e) {
      this.logMessage("error", e);
    }
  }

  /**
   * Fetch and setup configuration
   */
  private setupConfig(options: IJestHTMLReporterConfigOptions) {
    this.config = {
      append: {
        defaultValue: false,
        environmentVariable: "JEST_HTML_REPORTER_APPEND",
        configValue: options.append
      },
      boilerplate: {
        defaultValue: null,
        environmentVariable: "JEST_HTML_REPORTER_BOILERPLATE",
        configValue: options.boilerplate
      },
      customScriptPath: {
        defaultValue: null,
        environmentVariable: "JEST_HTML_REPORTER_CUSTOM_SCRIPT_PATH",
        configValue: options.customScriptPath
      },
      dateFormat: {
        defaultValue: "yyyy-mm-dd HH:MM:ss",
        environmentVariable: "JEST_HTML_REPORTER_DATE_FORMAT",
        configValue: options.dateFormat
      },
      executionTimeWarningThreshold: {
        defaultValue: 5,
        environmentVariable:
          "JEST_HTML_REPORTER_EXECUTION_TIME_WARNING_THRESHOLD",
        configValue: options.executionTimeWarningThreshold
      },
      logo: {
        defaultValue: null,
        environmentVariable: "JEST_HTML_REPORTER_LOGO",
        configValue: options.logo
      },
      includeFailureMsg: {
        defaultValue: false,
        environmentVariable: "JEST_HTML_REPORTER_INCLUDE_FAILURE_MSG",
        configValue: options.includeFailureMsg
      },
      includeConsoleLog: {
        defaultValue: false,
        environmentVariable: "JEST_HTML_REPORTER_INCLUDE_CONSOLE_LOG",
        configValue: options.includeConsoleLog
      },
      outputPath: {
        defaultValue: path.join(process.cwd(), "test-report.html"),
        environmentVariable: "JEST_HTML_REPORTER_OUTPUT_PATH",
        configValue: options.outputPath
      },
      pageTitle: {
        defaultValue: "Test Report",
        environmentVariable: "JEST_HTML_REPORTER_PAGE_TITLE",
        configValue: options.pageTitle
      },
      theme: {
        defaultValue: "defaultTheme",
        environmentVariable: "JEST_HTML_REPORTER_THEME",
        configValue: options.theme
      },
      sort: {
        defaultValue: null,
        environmentVariable: "JEST_HTML_REPORTER_SORT",
        configValue: options.sort
      },
      statusIgnoreFilter: {
        defaultValue: null,
        environmentVariable: "JEST_HTML_REPORTER_STATUS_FILTER",
        configValue: options.statusIgnoreFilter
      },
      styleOverridePath: {
        defaultValue: null,
        environmentVariable: "JEST_HTML_REPORTER_STYLE_OVERRIDE_PATH",
        configValue: options.styleOverridePath
      },
      useCssFile: {
        defaultValue: false,
        environmentVariable: "JEST_HTML_REPORTER_USE_CSS_FILE",
        configValue: options.useCssFile
      }
    };
    // Attempt to collect and assign config settings from jesthtmlreporter.config.json
    try {
      const jesthtmlreporterconfig = fs.readFileSync(
        path.join(process.cwd(), "jesthtmlreporter.config.json"),
        "utf8"
      );
      if (jesthtmlreporterconfig) {
        const parsedConfig = JSON.parse(jesthtmlreporterconfig);
        for (const key of Object.keys(parsedConfig)) {
          if (this.config[key as keyof IJestHTMLReporterConfig]) {
            this.config[key as keyof IJestHTMLReporterConfig].configValue =
              parsedConfig[key];
          }
        }
        return;
      }
    } catch (e) {
      /** do nothing */
    }
    // If above method did not work we attempt to check package.json
    try {
      const packageJson = fs.readFileSync(
        path.join(process.cwd(), "package.json"),
        "utf8"
      );
      if (packageJson) {
        const parsedConfig = JSON.parse(packageJson)["jest-html-reporter"];
        for (const key of Object.keys(parsedConfig)) {
          if (this.config[key as keyof IJestHTMLReporterConfig]) {
            this.config[key as keyof IJestHTMLReporterConfig].configValue =
              parsedConfig[key];
          }
        }
      }
    } catch (e) {
      /** do nothing */
    }
  }

  /**
   * Returns the configurated value from the config in the following priority order:
   * Environment Variable > JSON configured value > Default value
   * @param key
   */
  private getConfigValue(key: keyof IJestHTMLReporterConfig) {
    const option = this.config[key];
    if (!option) {
      return;
    }
    if (process.env[option.environmentVariable]) {
      return process.env[option.environmentVariable];
    }
    return option.configValue || option.defaultValue;
  }

  /**
   * Method for logging to the terminal
   * @param type
   * @param message
   * @param ignoreConsole
   */
  private logMessage(
    type: "default" | "success" | "error" = "default",
    message: string
  ) {
    const logTypes = {
      default: "\x1b[37m%s\x1b[0m",
      success: "\x1b[32m%s\x1b[0m",
      error: "\x1b[31m%s\x1b[0m"
    };
    const logColor = !logTypes[type] ? logTypes.default : logTypes[type];
    const logMsg = `jest-html-reporter >> ${message}`;
    // Let's log messages to the terminal only if we aren't testing this very module
    if (process.env.JEST_WORKER_ID === undefined) {
      console.log(logColor, logMsg);
    }
    return { logColor, logMsg }; // Return for testing purposes
  }
}

export default HTMLReporter;
