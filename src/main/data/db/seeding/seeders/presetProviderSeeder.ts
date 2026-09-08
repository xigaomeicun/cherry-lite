import { RegistryLoader } from '@cherrystudio/provider-registry/node'
import { resolveRegistryPaths } from '@data/services/utils/registryDataPaths'

import type { DbType, ISeeder } from '../../types'

export class PresetProviderSeeder implements ISeeder {
  readonly name = 'presetProvider'
  readonly description = 'Insert preset provider configurations'

  private _loader?: RegistryLoader

  private getLoader(): RegistryLoader {
    if (!this._loader) {
      this._loader = new RegistryLoader(resolveRegistryPaths())
    }
    return this._loader
  }

  get version(): string {
    return this.getLoader().getProvidersVersion()
  }

  run(_db: DbType): void {
    // Cherry-Lite: 彻底绝育！不自动往数据库塞入 60+ 个商业服务商预设，只留用户自己配置的代理和本地模型
    return
  }
}
