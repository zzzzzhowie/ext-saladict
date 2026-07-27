/**
 * Profiles are switchable profiles
 */
import pako from 'pako'
import {
  getDefaultProfile,
  Profile,
  ProfileMutable,
  genProfilesStorage,
  ProfileIDList,
  ProfileID
} from '@/app-config/profiles'
import { mergeProfile } from '@/app-config/merge-profile'
import { storage } from './browser-api'
import { TFunction } from 'i18next'
import isEqual from 'lodash/isEqual'

import { Observable, from, concat, fromEventPattern } from 'rxjs'
import { map } from 'rxjs/operators'

/**
 * Profiles are stored in `storage.local` (not `storage.sync`) — see
 * config-manager's note: `sync` has an 8KB per-item cap that a large profile
 * (e.g. a long OpenAI prompt) can exceed. Migration lives there too.
 */
const store = storage.local

export interface StorageChanged<T> {
  newValue: T
  oldValue?: T
}

export interface ProfileChanged {
  newProfile: Profile
  oldProfile?: Profile
}

/** Compressed full profile data */
interface ProfileCompressedV1 {
  /** version */
  v: 1
  /** data */
  d: string
}

/** Compressed sparse profile data */
interface ProfileCompressedV2 {
  /** version */
  v: 2
  /** data */
  d: string
}

type ProfileCompressed = ProfileCompressedV1 | ProfileCompressedV2
type StoredProfile = Profile | ProfileCompressed
type ProfilePatch = Partial<ProfileMutable>

export function deflate(profile: Profile): ProfileCompressedV2 {
  return {
    v: 2,
    d: pako.deflate(JSON.stringify(createProfilePatch(profile)), {
      to: 'string'
    })
  }
}

export function inflate(profile: Profile | ProfileCompressed): Profile
export function inflate(profile: undefined): undefined
export function inflate(
  profile?: Profile | ProfileCompressed
): Profile | undefined
export function inflate(
  profile?: Profile | ProfileCompressed
): Profile | undefined {
  if (profile && profile['v'] === 1) {
    // Merge against defaults so dicts/options added after this profile was
    // stored (e.g. new dictionaries) show up for legacy v1 profiles too.
    return mergeProfile(
      JSON.parse(
        pako.inflate((profile as ProfileCompressedV1).d, { to: 'string' })
      )
    )
  }
  if (profile && profile['v'] === 2) {
    const patch = JSON.parse(
      pako.inflate((profile as ProfileCompressedV2).d, { to: 'string' })
    )
    return mergeProfile(patch)
  }
  // Uncompressed legacy profile — merge so it picks up newly-added dicts.
  return profile ? mergeProfile(profile as Profile) : undefined
}

function createProfilePatch(profile: Profile): ProfilePatch {
  const patch = diffValue(profile, getDefaultProfile(profile.id)) || {}

  patch.id = profile.id
  patch.version = profile.version

  return patch
}

function diffValue(value: any, baseValue: any): any {
  if (!isPlainObject(value) || !isPlainObject(baseValue)) {
    return isEqual(value, baseValue) ? undefined : value
  }

  const result = {}
  Object.keys(value).forEach(key => {
    const diff = diffValue(value[key], baseValue[key])
    if (diff !== undefined) {
      result[key] = diff
    }
  })

  return Object.keys(result).length > 0 ? result : undefined
}

function isPlainObject(value: any): value is { [key: string]: any } {
  return Object.prototype.toString.call(value) === '[object Object]'
}

function isProfileCompressedV2(
  profile?: StoredProfile
): profile is ProfileCompressedV2 {
  return Boolean(
    profile && profile['v'] === 2 && typeof profile['d'] === 'string'
  )
}

function shouldUpdateStoredProfile(
  storedProfile: StoredProfile | undefined,
  profile: Profile
): boolean {
  if (!isProfileCompressedV2(storedProfile)) {
    return true
  }

  return deflate(profile).d !== storedProfile.d
}

export function getProfileName(name: string, t: TFunction): string {
  // default names
  const match = /^%%_(\S+)_%%$/.exec(name)
  if (match) {
    return t(`common:profile.${match[1]}`) || name
  }
  return name
}

export async function initProfiles(): Promise<Profile> {
  let profiles: Profile[] = []
  let profilesToUpdate: Profile[] = []
  let profileIDList: ProfileIDList = []
  let activeProfileID = ''

  const response = await store.get<{
    profileIDList: ProfileIDList
    activeProfileID: string
  }>(['profileIDList', 'activeProfileID'])

  if (response.profileIDList) {
    profileIDList = response.profileIDList.filter(item =>
      Boolean(
        item && typeof item.id === 'string' && typeof item.name === 'string'
      )
    )
  }

  if (response.activeProfileID) {
    activeProfileID = response.activeProfileID
  }

  if (profileIDList.length > 0) {
    // quota bytes limit
    for (const { id } of profileIDList) {
      const storedProfile = await getStoredProfile(id)
      const profile = inflate(storedProfile)
      const mergedProfile = profile
        ? mergeProfile(profile)
        : getDefaultProfile(id)
      profiles.push(mergedProfile)
      if (shouldUpdateStoredProfile(storedProfile, mergedProfile)) {
        profilesToUpdate.push(mergedProfile)
      }
    }
  } else {
    ;({ profileIDList, profiles } = genProfilesStorage())
    profilesToUpdate = profiles
    activeProfileID = profileIDList[0].id
  }

  if (!activeProfileID) {
    activeProfileID = profileIDList[0].id
  }

  let activeProfile = profiles.find(({ id }) => id === activeProfileID)
  if (!activeProfile) {
    activeProfile = profiles[0]
    activeProfileID = activeProfile.id
  }

  await store.set({ profileIDList, activeProfileID })

  // quota bytes per item limit
  for (const profile of profilesToUpdate) {
    await updateProfile(profile)
  }

  return activeProfile
}

export async function resetAllProfiles() {
  const { profileIDList } = await store.get<{
    profileIDList: ProfileIDList
  }>('profileIDList')

  if (profileIDList) {
    await store.remove([
      ...profileIDList.map(({ id }) => id),
      'profileIDList',
      'activeProfileID',
      // legacy
      'configProfileIDs',
      'activeConfigID'
    ])
  }
  return initProfiles()
}

export async function getProfile(id: string): Promise<Profile | undefined> {
  return inflate(await getStoredProfile(id))
}

async function getStoredProfile(
  id: string
): Promise<StoredProfile | undefined> {
  const result = await store.get<{ [key: string]: StoredProfile }>(id)
  return result[id]
}

/**
 * Update profile
 */
export async function updateProfile(profile: Profile): Promise<void> {
  if (process.env.DEBUG) {
    const profileIDList = await getProfileIDList()
    if (!profileIDList.find(item => item.id === profile.id)) {
      console.error(`Update Profile: profile ${profile.id} does not exist`)
    } else {
      console.log('Savedd Profile', profile)
    }
  }
  return store.set({ [profile.id]: deflate(profile) })
}

export async function addProfile(profileID: ProfileID): Promise<void> {
  const id = profileID.id
  const profileIDList = await getProfileIDList()
  if (process.env.DEBUG) {
    if (profileIDList.find(item => item.id === id) || (await getProfile(id))) {
      console.warn(`Add profile: profile ${id} exists`)
    }
  }

  return store.set({
    profileIDList: [...profileIDList, profileID],
    [id]: deflate(getDefaultProfile(id))
  })
}

export async function removeProfile(id: string): Promise<void> {
  const activeProfileID = await getActiveProfileID()
  let profileIDList = await getProfileIDList()
  if (process.env.DEBUG) {
    if (
      !profileIDList.find(item => item.id === id) ||
      !(await getProfile(id))
    ) {
      console.warn(`Remove profile: profile ${id} does not exists`)
    }
  }
  profileIDList = profileIDList.filter(item => item.id !== id)
  if (activeProfileID === id) {
    await updateActiveProfileID(profileIDList[0].id)
  }
  await updateProfileIDList(profileIDList)
  return store.remove(id)
}

/**
 * Get the profile under the current mode
 */
export async function getActiveProfile(): Promise<Profile> {
  const activeProfileID = await getActiveProfileID()
  if (activeProfileID) {
    const profile = await getProfile(activeProfileID)
    if (profile) {
      return profile
    }
  }
  return getDefaultProfile()
}

export async function getActiveProfileID(): Promise<string> {
  return (await store.get('activeProfileID')).activeProfileID || ''
}

export function updateActiveProfileID(id: string): Promise<void> {
  return store.set({ activeProfileID: id })
}

/**
 * This is mainly for ordering
 */
export async function getProfileIDList(): Promise<ProfileIDList> {
  return (await store.get('profileIDList')).profileIDList || []
}

/**
 * This is mainly for ordering
 */
export function updateProfileIDList(list: ProfileIDList): Promise<void> {
  return store.set({ profileIDList: list })
}

export function addActiveProfileIDListener(
  cb: (changes: StorageChanged<string>) => any
) {
  store.addListener('activeProfileID', ({ activeProfileID }) => {
    if (activeProfileID && activeProfileID.newValue) {
      cb(activeProfileID as StorageChanged<string>)
    }
  })
}

export function addProfileIDListListener(
  cb: (changes: StorageChanged<ProfileIDList>) => any
) {
  store.addListener('profileIDList', ({ profileIDList }) => {
    if (profileIDList && profileIDList.newValue) {
      cb(profileIDList as StorageChanged<ProfileIDList>)
    }
  })
}

/**
 * Listen storage changes of the current profile
 */
export async function addActiveProfileListener(
  cb: (changes: ProfileChanged) => any
) {
  let activeID: string | undefined = await getActiveProfileID()

  store.addListener(changes => {
    // this id changed
    if (changes.activeProfileID) {
      const { newValue: newID, oldValue: oldID } = (changes as {
        activeProfileID: StorageChanged<string>
      }).activeProfileID
      if (newID) {
        activeID = newID
        if (oldID) {
          store.get([oldID, newID]).then(obj => {
            if (obj[newID]) {
              cb({
                newProfile: inflate(obj[newID]),
                oldProfile: inflate(obj[oldID])
              })
              return
            }
          })
        } else {
          getProfile(newID).then(newProfile => {
            if (newProfile) {
              cb({ newProfile })
              return
            }
          })
        }
      }
    }

    // the active profile itself updated
    if (activeID && changes[activeID]) {
      const { newValue, oldValue } = changes[activeID] as StorageChanged<
        StoredProfile
      >
      if (newValue) {
        cb({ newProfile: inflate(newValue), oldProfile: inflate(oldValue) })
        return
      }
    }
  })
}

/**
 * Get active profile and create a stream listening to profile changing
 */
export function createProfileIDListStream(): Observable<ProfileIDList> {
  return concat(
    from(getProfileIDList()),
    fromEventPattern<
      [StorageChanged<ProfileIDList>] | StorageChanged<ProfileIDList>
    >(addProfileIDListListener as any).pipe(
      map(args => (Array.isArray(args) ? args[0] : args).newValue)
    )
  )
}

/**
 * Get active profile and create a stream listening to profile changing
 */
export function createActiveProfileStream(): Observable<Profile> {
  return concat(
    from(getActiveProfile()),
    fromEventPattern<[ProfileChanged] | ProfileChanged>(
      addActiveProfileListener as any
    ).pipe(map(args => (Array.isArray(args) ? args[0] : args).newProfile))
  )
}
