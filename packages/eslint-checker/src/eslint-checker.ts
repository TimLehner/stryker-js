import fs from 'fs';

import fg from 'fast-glob';
import { ESLint } from 'eslint';
import { Checker, CheckResult, CheckStatus } from '@stryker-mutator/api/check';
import { tokens, commonTokens, PluginContext, Injector, Scope } from '@stryker-mutator/api/plugin';
import { Mutant, StrykerOptions } from '@stryker-mutator/api/core';
import { Logger, LoggerFactoryMethod } from '@stryker-mutator/api/logging';

import { ScriptFile } from './script-file.js';
import { isFailedResult, makeResultFromLintReport } from './result-helpers.js';
import { overrideOptions } from './esconfig-helpers.js';

export class LintChecker implements Checker {
  private linter: ESLint;
  public static inject = tokens(commonTokens.logger, commonTokens.options);

  constructor(private readonly logger: Logger, private readonly options: StrykerOptions) {
    this.linter = new ESLint();
  }

  private async lintFileContent(filename: string, fileText?: string): Promise<CheckResult> {
    this.logger.debug(`Now linting file: ${filename} with text`);
    this.logger.debug(fileText ?? '');
    if (!fileText) {
      this.logger.debug(CheckStatus.Passed);
      return { status: CheckStatus.Passed };
    }
    const results = await this.linter.lintText(fileText);
    const formatter = await this.linter.loadFormatter();
    return await makeResultFromLintReport(results, formatter);
  }

  public async init(): Promise<void> {
    const overrideConfig = await this.adjustConfigFile(this.options.lintConfigFile as string);
    this.linter = new ESLint({ overrideConfig });
    this.logger.info('starting initial lint dry-run');
    const files = await fg(this.options.mutate);
    const allResults = await Promise.all(
      files.map((filename) => {
        return this.lintFileContent(filename, fs.readFileSync(filename).toString());
      })
    );
    const errors = allResults.filter(isFailedResult);
    if (errors.length > 0) {
      const errorReasons = errors.map((e) => e.reason);
      throw new Error(['Lint error(s) found in dry run compilation:', ...errorReasons].join('\n'));
    }
    this.logger.info('lint check dry-run completed');
  }

  public async check(mutants: Mutant[]): Promise<Record<string, CheckResult>> {
    const mutant = mutants[0];

    this.logger.debug(`Asked to check ${mutant.fileName}`);
    if (!fs.existsSync(mutant.fileName)) {
      this.logger.debug('nothing to do');
      return {
        [mutant.id]: {
          status: CheckStatus.Passed,
        },
      };
    }

    const contents = fs.readFileSync(mutant.fileName).toString();
    const asScriptFile = new ScriptFile(contents, mutant.fileName);
    asScriptFile.mutate(mutant);
    const result = await this.lintFileContent(mutant.fileName, asScriptFile.content);
    return {
      [mutant.id]: result,
    };
  }

  /**
   * Post processes the content of a eslint config file. Adjusts some options for speed and alters quality options.
   * @param fileName The eslint file name
   * @param content The eslint content
   */
  private async adjustConfigFile(fileName?: string): Promise<ESLint.Options['overrideConfig']> {
    if (fileName) {
      const { default: parsedConfig } = await import(fileName);
      return overrideOptions({ config: parsedConfig });
    }
    return {};
  }
}

lintCheckerLoggerFactory.inject = tokens(commonTokens.getLogger, commonTokens.target);
// eslint-disable-next-line @typescript-eslint/ban-types
function lintCheckerLoggerFactory(loggerFactory: LoggerFactoryMethod, target: Function | undefined) {
  const targetName = target?.name ?? LintChecker.name;
  const category = targetName === LintChecker.name ? LintChecker.name : `${LintChecker.name}.${targetName}`;
  return loggerFactory(category);
}

create.inject = tokens(commonTokens.injector);
export function create(injector: Injector<PluginContext>): LintChecker {
  return injector.provideFactory(commonTokens.logger, lintCheckerLoggerFactory, Scope.Transient).injectClass(LintChecker);
}
