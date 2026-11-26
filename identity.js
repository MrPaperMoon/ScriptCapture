import { faker } from './node_modules/@faker-js/faker/dist/locale/en.js'
import { isName, isSessionName } from './room-protocol.js'

export function newName(excluded) {
  let name
  do {
    name = faker.person.firstName()
  } while (!isName(name) || name === excluded)
  return name
}

export function newSessionName() {
  let name
  do {
    name = faker.git.branch()
  } while (!isSessionName(name))
  return name
}
