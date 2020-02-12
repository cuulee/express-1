const path = require('path')
const AWS = require('aws-sdk')
const { readFile, copySync } = require('fs-extra')

/*
 * Pauses execution for the provided miliseconds
 *
 * @param ${number} wait - number of miliseconds to wait
 */
const sleep = async (wait) => new Promise((resolve) => setTimeout(() => resolve(), wait))

/*
 * Logs a message
 *
 * @param ${string} msg - message to log
 */
const log = async (msg) => console.log(msg) // eslint-disable-line

/*
 * Generates a random id
 */
const generateId = () =>
  Math.random()
    .toString(36)
    .substring(6)

/*
 * Initializes an AWS SDK and returns the relavent service clients
 *
 * @param ${object} credentials - aws credentials object
 * @param ${string} region - aws region
 */
const getClients = (credentials, region) => {
  const iam = new AWS.IAM({ credentials, region })
  const lambda = new AWS.Lambda({ credentials, region })
  const apig = new AWS.APIGateway({ credentials, region })
  const apig2 = new AWS.ApiGatewayV2({ credentials, region })
  const route53 = new AWS.Route53({ credentials, region })
  const acm = new AWS.ACM({
    credentials,
    region: 'us-east-1' // ACM must be in us-east-1
  })

  return {
    iam,
    lambda,
    apig,
    apig2,
    route53,
    acm
  }
}

/*
 * Extracts the naked second level domain (ie. serverless.com) from
 * the provided domain or subdomain (ie. api.serverless.com)
 *
 * @param ${string} domain - the domain input that the user provided
 */
const getNakedDomain = (domain) => {
  if (!domain) {
    return null
  }
  const domainParts = domain.split('.')
  const topLevelDomainPart = domainParts[domainParts.length - 1]
  const secondLevelDomainPart = domainParts[domainParts.length - 2]
  return `${secondLevelDomainPart}.${topLevelDomainPart}`
}

const getConfig = (inputs, state, org, stage, app, name) => {
  if (!inputs.src) {
    throw new Error(`Missing "src" input.`)
  }
  const id = generateId()

  const config = {
    src: inputs.src,
    region: inputs.region || 'us-east-1',
    domain: inputs.domain,
    nakedDomain: inputs.domain ? getNakedDomain(inputs.domain) : null,
    role: state.role || {},
    lambda: state.lambda || {},
    apig: state.apig || {}
  }

  if (!config.role.name) {
    config.role = {
      name: `express-${id}`,
      description: `Serverless Express app role for ${org} - ${stage} - ${app} - ${name}`
    }
  }

  if (!config.lambda.name) {
    config.lambda = {
      name: `express-${id}`,
      description: `Serverless Express app Lambda for ${org} - ${stage} - ${app} - ${name}`,
      handler: '_express/index.handler',
      memory: 3008,
      timeout: 900,
      runtime: 'nodejs12.x',
      env: {}
    }
  }

  if (!config.apig.name) {
    config.apig = {
      name: `express-${id}`,
      stage: 'default',
      description: `Serverless Express app API for ${org} - ${stage} - ${app} - ${name}`,
      endpoints: [
        {
          path: '/',
          method: 'ANY'
        },
        {
          path: '/{proxy+}',
          method: 'ANY'
        }
      ]
    }
  }

  if (inputs.env) {
    config.lambda.env = inputs.env
  }

  if (inputs.memory) {
    config.lambda.memory = inputs.memory
  }

  if (inputs.timeout) {
    config.lambda.timeout = inputs.timeout
  }

  if (inputs.description) {
    config.lambda.description = inputs.description
    config.apig.description = inputs.description
  }

  config.domainHostedZoneId = state.domainHostedZoneId
  config.certificateArn = state.certificateArn

  return config
}

const getRole = async (clients, config) => {
  try {
    const res = await clients.iam.getRole({ RoleName: config.role.name }).promise()
    return {
      name: res.Role.RoleName,
      arn: res.Role.Arn
    }
  } catch (e) {
    if (e.message.includes('cannot be found')) {
      return config.role
    }
    throw e
  }
}

const createRole = async (clients, config) => {
  const assumeRolePolicyDocument = {
    Version: '2012-10-17',
    Statement: {
      Effect: 'Allow',
      Principal: {
        Service: ['lambda.amazonaws.com', 'apigateway.amazonaws.com']
      },
      Action: 'sts:AssumeRole'
    }
  }
  const res = await clients.iam
    .createRole({
      RoleName: config.role.name,
      Path: '/',
      AssumeRolePolicyDocument: JSON.stringify(assumeRolePolicyDocument)
    })
    .promise()

  await clients.iam
    .attachRolePolicy({
      RoleName: config.role.name,
      PolicyArn: 'arn:aws:iam::aws:policy/AdministratorAccess'
    })
    .promise()

  return { name: res.Role.RoleName, arn: res.Role.Arn }
}

const getLambda = async (clients, config) => {
  try {
    const res = await clients.lambda
      .getFunctionConfiguration({
        FunctionName: config.lambda.name
      })
      .promise()

    return {
      name: res.FunctionName,
      description: res.Description,
      timeout: res.Timeout,
      runtime: res.Runtime,
      handler: res.Handler,
      memory: res.MemorySize,
      hash: res.CodeSha256,
      env: res.Environment ? res.Environment.Variables : {},
      arn: res.FunctionArn
    }
  } catch (e) {
    if (e.code === 'ResourceNotFoundException') {
      return config.lambda
    }
    throw e
  }
}

const createLambda = async (clients, config) => {
  const params = {
    FunctionName: config.lambda.name,
    Code: {},
    Description: config.lambda.description,
    Handler: config.lambda.handler,
    MemorySize: config.lambda.memory,
    Publish: false,
    Role: config.role.arn,
    Runtime: config.lambda.runtime,
    Timeout: config.lambda.timeout,
    Environment: {
      Variables: config.lambda.env
    }
  }

  if (config.lambda.layers) {
    params.Layers = config.lambda.layers
  }

  params.Code.ZipFile = await readFile(config.lambda.zipPath)

  try {
    const res = await clients.lambda.createFunction(params).promise()
    return {
      name: res.FunctionName,
      description: res.Description,
      timeout: res.Timeout,
      runtime: res.Runtime,
      handler: res.Handler,
      memory: res.MemorySize,
      hash: res.CodeSha256,
      env: res.Environment ? res.Environment.Variables : {},
      arn: res.FunctionArn
    }
  } catch (e) {
    if (e.message.includes(`The role defined for the function cannot be assumed by Lambda`)) {
      // we need to wait around 9 seconds after the role is craated before it can be assumed
      await sleep(1000)
      return createLambda(clients, config)
    }
    throw e
  }
}

const updateLambdaCode = async (clients, config) => {
  const functionCodeParams = {
    FunctionName: config.lambda.name,
    Publish: false
  }

  functionCodeParams.ZipFile = await readFile(config.lambda.zipPath)

  const res = await clients.lambda.updateFunctionCode(functionCodeParams).promise()

  return {
    name: res.FunctionName,
    description: res.Description,
    timeout: res.Timeout,
    runtime: res.Runtime,
    handler: res.Handler,
    memory: res.MemorySize,
    hash: res.CodeSha256,
    env: res.Environment ? res.Environment.Variables : {},
    arn: res.FunctionArn
  }
}

const updateLambdaConfig = async (clients, config) => {
  const functionConfigParams = {
    FunctionName: config.lambda.name,
    Description: config.lambda.description,
    MemorySize: config.lambda.memory,
    Role: config.role.arn,
    Timeout: config.lambda.timeout,
    Environment: {
      Variables: config.lambda.env
    }
  }

  if (config.lambda.layers) {
    functionConfigParams.Layers = config.lambda.layers
  }

  const res = await clients.lambda.updateFunctionConfiguration(functionConfigParams).promise()

  return {
    name: res.FunctionName,
    description: res.Description,
    timeout: res.Timeout,
    runtime: res.Runtime,
    handler: res.Handler,
    memory: res.MemorySize,
    hash: res.CodeSha256,
    env: res.Environment ? res.Environment.Variables : {},
    arn: res.FunctionArn
  }
}

const packageExpress = async (instance, config) => {
  // unzip source zip file
  const sourceDirectory = await instance.unzip(config.src)

  // add shim to the source directory
  copySync(path.join(__dirname, 'include'), path.join(sourceDirectory, '_express'))

  console.log(config.lambda.handler)

  // add sdk to the source directory, add original handler
  config.lambda.handler = await instance.addSDK(sourceDirectory, '_express/index.handler')

  // zip the source directory with the shim and the sdk
  return instance.zip(sourceDirectory)
}

const getApiV2 = async (clients, config) => {
  if (!config.apig.id) {
    return config.apig
  }

  try {
    await clients.apig2.getApi({ ApiId: config.apig.id }).promise()
    return config.apig
  } catch (e) {
    if (e.code === 'NotFound') {
      // todo test this error code
      delete config.apig.id
      return config.apig
    }
  }
}

const createApiV2 = async (clients, config) => {
  const createApiParams = {
    Name: config.apig.name,
    ProtocolType: 'HTTP',
    CredentialsArn: config.role.arn,
    Description: config.apig.description,
    Target: `arn:aws:apigateway:${config.region}:lambda:path/2015-03-31/functions/${config.lambda.arn}/invocations`,
    CorsConfiguration: {
      AllowHeaders: ['*'],
      AllowOrigins: ['*']
    }
  }

  const res = await clients.apig2.createApi(createApiParams).promise()

  config.apig.id = res.ApiId

  return config.apig
}

const removeApiV2 = async (clients, config) => {
  if (!config.apig || !config.apig.id) {
    return
  }

  try {
    await clients.apig2.deleteApi({ ApiId: config.apig.id })
  } catch (e) {}
}

const removeRole = async (clients, config) => {
  if (!config.role || !config.role.name) {
    return
  }
  try {
    await clients.iam
      .detachRolePolicy({
        RoleName: config.role.name,
        PolicyArn: 'arn:aws:iam::aws:policy/AdministratorAccess'
      })
      .promise()
    await clients.iam
      .deleteRole({
        RoleName: config.role.name
      })
      .promise()
  } catch (error) {
    if (error.code !== 'NoSuchEntity') {
      throw error
    }
  }
}

const removeLambda = async (clients, config) => {
  if (!config.lambda || !config.lambda.name) {
    return
  }
  try {
    const params = { FunctionName: config.lambda.name }
    await clients.lambda.deleteFunction(params).promise()
  } catch (error) {
    if (error.code !== 'ResourceNotFoundException') {
      throw error
    }
  }
}

const getDomainHostedZoneId = async (clients, config) => {
  const hostedZonesRes = await clients.route53.listHostedZonesByName().promise()

  const hostedZone = hostedZonesRes.HostedZones.find(
    // Name has a period at the end, so we're using includes rather than equals
    (zone) => zone.Name.includes(config.nakedDomain)
  )

  if (!hostedZone) {
    throw Error(
      `Domain ${config.nakedDomain} was not found in your AWS account. Please purchase it from Route53 first then try again.`
    )
  }

  return hostedZone.Id.replace('/hostedzone/', '') // hosted zone id is always prefixed with this :(
}

const getCertificateArnByDomain = async (clients, config) => {
  const listRes = await clients.acm.listCertificates().promise()
  const certificate = listRes.CertificateSummaryList.find(
    (cert) => cert.DomainName === config.nakedDomain
  )
  return certificate && certificate.CertificateArn ? certificate.CertificateArn : null
}

const describeCertificateByArn = async (clients, certificateArn) => {
  const certificate = await clients.acm
    .describeCertificate({ CertificateArn: certificateArn })
    .promise()
  return certificate && certificate.Certificate ? certificate.Certificate : null
}

const getCertificateValidationRecord = (certificate, domain) => {
  const domainValidationOption = certificate.DomainValidationOptions.filter(
    (option) => option.DomainName === domain
  )

  return domainValidationOption.ResourceRecord
}

const ensureCertificate = async (clients, config, instance) => {
  const wildcardSubDomain = `*.${config.nakedDomain}`

  const params = {
    DomainName: config.nakedDomain,
    SubjectAlternativeNames: [config.nakedDomain, wildcardSubDomain],
    ValidationMethod: 'DNS'
  }

  await instance.debug(`Checking if a certificate for the ${config.nakedDomain} domain exists`)
  let certificateArn = await getCertificateArnByDomain(clients, config)

  if (!certificateArn) {
    await instance.debug(
      `Certificate for the ${config.nakedDomain} domain does not exist. Creating...`
    )
    certificateArn = (await clients.acm.requestCertificate(params).promise()).CertificateArn
  }

  const certificate = await describeCertificateByArn(clients, certificateArn)

  if (certificate.Status !== 'ISSUED') {
    await instance.debug(`Validating the certificate for the ${config.nakedDomain} domain.`)

    const certificateValidationRecord = getCertificateValidationRecord(
      certificate,
      config.nakedDomain
    )

    const recordParams = {
      HostedZoneId: config.domainHostedZoneId,
      ChangeBatch: {
        Changes: [
          {
            Action: 'UPSERT',
            ResourceRecordSet: {
              Name: certificateValidationRecord.Name,
              Type: certificateValidationRecord.Type,
              TTL: 300,
              ResourceRecords: [
                {
                  Value: certificateValidationRecord.Value
                }
              ]
            }
          }
        ]
      }
    }
    await clients.route53.changeResourceRecordSets(recordParams).promise()
  }

  return certificateArn
}

const createDomainInApig = async (clients, config) => {
  try {
    const params = {
      domainName: config.domain,
      certificateArn: config.certificateArn,
      securityPolicy: 'TLS_1_2',
      endpointConfiguration: {
        types: ['EDGE']
      }
    }
    const res = await clients.apig.createDomainName(params).promise()
    return res
  } catch (e) {
    if (e.code === 'TooManyRequestsException') {
      await sleep(2000)
      return createDomainInApig(clients, config)
    }
    throw e
  }
}

const configureDnsForApigDomain = async (clients, config) => {
  const dnsRecord = {
    HostedZoneId: config.domainHostedZoneId,
    ChangeBatch: {
      Changes: [
        {
          Action: 'UPSERT',
          ResourceRecordSet: {
            Name: config.domain,
            Type: 'A',
            AliasTarget: {
              HostedZoneId: config.apig.distributionHostedZoneId,
              DNSName: config.apig.distributionDomainName,
              EvaluateTargetHealth: false
            }
          }
        }
      ]
    }
  }

  return clients.route53.changeResourceRecordSets(dnsRecord).promise()
}

/**
 * Map API Gateway API to the created API Gateway Domain
 */
const mapDomainToApi = async (clients, config) => {
  try {
    const params = {
      domainName: config.domain,
      restApiId: config.apig.id,
      basePath: '(none)',
      stage: config.apig.stage
    }
    // todo what if it already exists but for a different apiId
    return clients.apig.createBasePathMapping(params).promise()
  } catch (e) {
    if (e.code === 'TooManyRequestsException') {
      await sleep(2000)
      return mapDomainToApi(clients, config)
    }
    throw e
  }
}

const deployApiDomain = async (clients, config, instance) => {
  try {
    await instance.debug(`Mapping domain ${config.domain} to API ID ${config.apig.id}`)
    await mapDomainToApi(clients, config)
  } catch (e) {
    if (e.message === 'Invalid domain name identifier specified') {
      await instance.debug(`Domain ${config.domain} not found in API Gateway. Creating...`)

      const res = await createDomainInApig(clients, config)

      config.apig.distributionHostedZoneId = res.distributionHostedZoneId
      config.apig.distributionDomainName = res.distributionDomainName

      await instance.debug(`Configuring DNS for API Gateway domain ${config.domain}.`)

      await configureDnsForApigDomain(clients, config)

      // retry domain deployment now that domain is created
      return deployApiDomain(clients, config, instance)
    }

    if (e.message === 'Base path already exists for this domain name') {
      await instance.debug(`Domain ${config.domain} is already mapped to API ID ${config.apig.id}.`)
      return
    }
    throw new Error(e)
  }
}

/**
 * Remove API Gateway Domain
 */

const removeDomainFromApig = async (clients, config) => {
  const params = {
    domainName: config.domain
  }

  return clients.apig.deleteDomainName(params).promise()
}

/**
 * Remove API Gateway Domain DNS Records
 */

const removeDnsRecordsForApigDomain = async (clients, config) => {
  const dnsRecord = {
    HostedZoneId: config.domainHostedZoneId,
    ChangeBatch: {
      Changes: [
        {
          Action: 'DELETE',
          ResourceRecordSet: {
            Name: config.domain,
            Type: 'A',
            AliasTarget: {
              HostedZoneId: config.apig.distributionHostedZoneId,
              DNSName: config.apig.distributionDomainName,
              EvaluateTargetHealth: false
            }
          }
        }
      ]
    }
  }

  return clients.route53.changeResourceRecordSets(dnsRecord).promise()
}

const removeDomain = async (clients, config) => {
  await Promise.all([
    removeDomainFromApig(clients, config),
    removeDnsRecordsForApigDomain(clients, config)
  ])
}

module.exports = {
  log,
  generateId,
  sleep,
  getClients,
  getConfig,
  getRole,
  createRole,
  getLambda,
  getApiV2,
  createApiV2,
  removeApiV2,
  createLambda,
  updateLambdaCode,
  updateLambdaConfig,
  packageExpress,
  removeRole,
  removeLambda,
  ensureCertificate,
  getDomainHostedZoneId,
  deployApiDomain,
  removeDomain
}