import cdk = require('@aws-cdk/core');
import ecs = require('@aws-cdk/aws-ecs');
import ec2 = require('@aws-cdk/aws-ec2');
import ecr = require('@aws-cdk/aws-ecr');
import ecsPatterns = require("@aws-cdk/aws-ecs-patterns");
import appmesh = require('@aws-cdk/aws-appmesh');
import elbv2 = require('@aws-cdk/aws-elasticloadbalancingv2');
import servicediscovery = require('@aws-cdk/aws-servicediscovery');
import ssm = require('@aws-cdk/aws-ssm');

/******************************************************************************
*************************** Ec2AppMeshService *********************************
******************************************************************************/

export interface AppMeshServiceProps {
  cluster: ecs.Cluster;
  mesh: appmesh.IMesh;
  portNumber: number;
  applicationContainer: any
}

export class Ec2AppMeshService extends cdk.Construct {
	
  // Members of the class
  ecsService: ecs.Ec2Service;
  serviceName: string;
  portNumber: number;
  taskDefinition: ecs.Ec2TaskDefinition;
  applicationContainer: ecs.ContainerDefinition;
  cwAgentContainer: ecs.ContainerDefinition;
  envoyContainer: ecs.ContainerDefinition;
  virtualService: appmesh.VirtualService;
  virtualNode: appmesh.VirtualNode;
  
  constructor(scope: cdk.Construct, id: string, props: AppMeshServiceProps) {
    super(scope, id);
  /*  ecsService: ecs.Ec2Service;
    serviceName: string;
    virtualNode: appmesh.VirtualNode; */
	this.serviceName = id;
	this.portNumber = props.portNumber;
    //const appMeshRepository = ecs.ContainerImage.fromRegistry("envoyproxy/envoy:v1.12.2");
	const appMeshRepository = ecr.Repository.fromRepositoryArn(this, 'app-mesh-envoy', 'arn:aws:ecr:us-west-2:840364872350:repository/aws-appmesh-envoy');
	// 840364872350.dkr.ecr.us-west-2.amazonaws.com/aws-appmesh-envoy:v1.12.1.1-prod
    const cluster = props.cluster;
    const mesh = props.mesh;
    const applicationContainer = props.applicationContainer;
	
	//const svcnamespace = props.svcnamespace;
	this.taskDefinition = new ecs.Ec2TaskDefinition(this, `${this.serviceName}-task-definition`, {
      networkMode: ecs.NetworkMode.AWS_VPC,
      proxyConfiguration: new ecs.AppMeshProxyConfiguration({
        containerName: 'envoy',
        properties: {
          appPorts: [this.portNumber],
          proxyEgressPort: 15001,
          proxyIngressPort: 15000,
          ignoredUID: 1337,
          egressIgnoredIPs: [
            '169.254.170.2',
            '169.254.169.254'
          ]
        }
      }) 
    });

	// Set-up application container, which was passed in from caller.
    this.applicationContainer = this.taskDefinition.addContainer('app', applicationContainer);
    this.applicationContainer.addPortMappings({
      containerPort: this.portNumber,
      hostPort: this.portNumber
    });

    this.envoyContainer = this.taskDefinition.addContainer('envoy', {
      //name: 'envoy',
      //image: appMeshRepository,
	  image: ecs.ContainerImage.fromEcrRepository(appMeshRepository, 'v1.12.1.1-prod'),
      essential: true,
      environment: {
        APPMESH_VIRTUAL_NODE_NAME: `mesh/${mesh.meshName}/virtualNode/${this.serviceName}`,
        AWS_REGION: cdk.Stack.of(this).region,
		ENABLE_ENVOY_STATS_TAGS: '1',
		ENABLE_ENVOY_DOG_STATSD: '1',
		ENVOY_LOG_LEVEL: 'debug'
      },
      healthCheck: {
        command: [
          'CMD-SHELL',
          'curl -s http://localhost:9901/server_info | grep state | grep -q LIVE'
        ],
        startPeriod: cdk.Duration.seconds(10),
        interval: cdk.Duration.seconds(5),
        timeout: cdk.Duration.seconds(2),
        retries: 3
      },
      memoryLimitMiB: 128,
      user: '1337',
      logging: new ecs.AwsLogDriver({
        streamPrefix: `${this.serviceName}-envoy`
      })
    });
	
	// Adding CloudWatch logging container.
	// This container listends on StatsD port, and forwards to CloudWatch
    //const stringValue = ssm.StringParameter.fromStringParameterAttributes(this, 'MyValue', {
      //parameterName: 'AmazonCloudWatch-linux',
      // 'version' can be specified but is optional.
		//}).stringValue;	
    this.cwAgentContainer = this.taskDefinition.addContainer('cloudwatch-agent', {
		image: ecs.ContainerImage.fromRegistry("amazon/cloudwatch-agent:latest"),
		memoryLimitMiB: 512,
		essential: false,
		environment: { 
			CW_CONFIG_CONTENT: '{"agent": {"omit_hostname": true, \
			"region": "us-west-2", \
			"logfile": "/opt/aws/amazon-cloudwatch-agent/logs/amazon-cloudwatch-agent.log", \
            "debug": true}, \
			"metrics": {"metrics_collected": {"statsd": \
			{"service_address":":8125","metrics_collection_interval":10, \
            "metrics_aggregation_interval":60}}}}'
		}
	});  

	// Set start-up order of containers
    this.applicationContainer.addContainerDependencies(
		{
      	  container: this.envoyContainer,
		  condition: ecs.ContainerDependencyCondition.HEALTHY
		},
		{
      	  container: this.cwAgentContainer,
	  	  condition: ecs.ContainerDependencyCondition.START
    	} 
	); 
	
	// ecsService: ecs.Ec2Service;
    this.ecsService = new ecs.Ec2Service(this, `${this.serviceName}-service`, {
      cluster: cluster,
      desiredCount: 2,
      taskDefinition: this.taskDefinition,
      cloudMapOptions: {
        dnsRecordType: servicediscovery.DnsRecordType.A,
        dnsTtl: cdk.Duration.seconds(10),
        failureThreshold: 2,
        name: this.serviceName
      }
    });
	
    // Create a virtual node for the name service
    this.virtualNode = new appmesh.VirtualNode(this, `${this.serviceName}-virtual-node`, {
      mesh: mesh,
      virtualNodeName: this.serviceName,
      cloudMapService: this.ecsService.cloudMapService,
      listener: {
        portMapping: {
          port: this.portNumber,
          protocol: appmesh.Protocol.HTTP,
        },
        healthCheck: {
          healthyThreshold: 2,
		  interval: cdk.Duration.seconds(5), // minimum
          path: '/',
          port: this.portNumber,
          protocol: appmesh.Protocol.HTTP,
		  timeout: cdk.Duration.seconds(2), // minimum
          unhealthyThreshold: 2
        }
      },
    });

    // Create virtual service to make the virtual node accessible
    this.virtualService = new appmesh.VirtualService(this, `${this.serviceName}-virtual-service`, {
      mesh: mesh,
      virtualNode: this.virtualNode,
	  virtualServiceName: `${this.serviceName}.internal`
      //virtualServiceName: `${this.serviceName}.${cluster.defaultCloudMapNamespace.namespaceName}`
    });
	//console.log(`${cluster.defaultCloudMapNamespace.namespaceName}`);
	//console.log(`${this.serviceName}`); console.log(`${this.serviceName}.internal`);
  }  // end of Constructor
  
  // Connect this mesh enabled service to another mesh enabled service.
  // This adjusts the security groups for both services so that they
  // can talk to each other. Also adjusts the virtual node for this service
  // so that its Envoy intercepts traffic that can be handled by the other
  // service's virtual service.
  connectToMeshService(appMeshService: Ec2AppMeshService) {
    var trafficPort = new ec2.Port({
      protocol: ec2.Protocol.TCP,
      fromPort: appMeshService.portNumber,
      toPort: 3000,
	  stringRepresentation: 'Inbound traffic from the app mesh enabled'
    });

    // Adjust security group to allow traffic from this app mesh enabled service
    // to the other app mesh enabled service.
    this.ecsService.connections.allowTo(appMeshService.ecsService, trafficPort, `Inbound traffic from the app mesh enabled ${this.serviceName}`);

    // Now adjust this app mesh service's virtual node to add a backend
    // that is the other service's virtual service
    this.virtualNode.addBackends(appMeshService.virtualService);
  }
}
// end of Class

/******************************************************************************
*************************** FargateAppMeshService *****************************
******************************************************************************/

export class FargateAppMeshService extends cdk.Construct {
	
  // Members of the class
    ecsService: ecs.FargateService;
    serviceName: string;
    portNumber: number;
    taskDefinition: ecs.Ec2TaskDefinition;
    applicationContainer: ecs.ContainerDefinition;
    virtualService: appmesh.VirtualService;
    virtualNode: appmesh.VirtualNode;
  
  constructor(scope: cdk.Construct, id: string, props: AppMeshServiceProps) {
    super(scope, id);
  /*  ecsService: ecs.Ec2Service;
    serviceName: string;
    virtualNode: appmesh.VirtualNode; */
	this.serviceName = id;
	this.portNumber = props.portNumber;
  	const appMeshRepository = ecs.ContainerImage.fromRegistry("envoyproxy/envoy:1.12.2");
  	const cluster = props.cluster;
  	const mesh = props.mesh;
  	const applicationContainer = props.applicationContainer;
	//const svcnamespace = props.svcnamespace;
	
	
    // const taskDefinition = new ecs.Ec2TaskDefinition(this, 'TaskDef');
	// const containerDefinition = new ecs.ContainerDefinition();

    this.taskDefinition = new ecs.FargateTaskDefinition(this, `${this.serviceName}-task-definition`, {
	  memoryLimitMiB: 4096,
	  cpu: 2048,
      proxyConfiguration: new ecs.AppMeshProxyConfiguration({
        containerName: 'envoy',
        properties: {
          appPorts: [this.portNumber],
          proxyEgressPort: 15001,
          proxyIngressPort: 15000,
          ignoredUID: 1337,
          egressIgnoredIPs: [
            '169.254.170.2',
            '169.254.169.254'
          ]
        }
      })
    });

	// Set-up application container, which was passed in from caller.
    this.applicationContainer = this.taskDefinition.addContainer('app', applicationContainer);
    this.applicationContainer.addPortMappings({
      containerPort: this.portNumber,
      hostPort: this.portNumber
    });

    const envoyContainer = this.taskDefinition.addContainer('envoy', {
      // name: 'envoy',
      image: appMeshRepository,
      essential: true,
      environment: {
        APPMESH_VIRTUAL_NODE_NAME: `mesh/${mesh.meshName}/virtualNode/${this.serviceName}`,
        AWS_REGION: cdk.Stack.of(this).region,
		ENABLE_ENVOY_STATS_TAGS: '0',
		ENABLE_ENVOY_DOG_STATSD: '0',
		ENVOY_LOG_LEVEL: 'debug'
      },
      healthCheck: {
        command: [
          'CMD-SHELL',
          'curl -s http://localhost:9901/server_info | grep state | grep -q LIVE'
        ],
        startPeriod: cdk.Duration.seconds(10),
        interval: cdk.Duration.seconds(5),
        timeout: cdk.Duration.seconds(2),
        retries: 3
      },
      memoryLimitMiB: 128,
      user: '1337',
      logging: new ecs.AwsLogDriver({
        streamPrefix: `${this.serviceName}-envoy`
      })
    });
	
	// Adding CloudWatch logging container.
	// This container listends on StatsD port, and forwards to CloudWatch	
    const cwAgent = this.taskDefinition.addContainer('cloudwatch-agent', {
		image: ecs.ContainerImage.fromRegistry("amazon/cloudwatch-agent:latest"),
		memoryLimitMiB: 512,
		essential: false,
	//	secrets: { 
	//		CW_CONFIG_CONTENT: ecs.Secret.fromSsmParameter("AmazonCloudWatch-linux")
	//	}
/*
		environment: {
			CW_CONFIG_CONTENT: {
	      "agent": {
	        "omit_hostname": true,
	        "run_as_user": "cwagent"
	      },
	      "metrics": {
	        "metrics_collected": {
	          "statsd": {
	            "service_address":":8125"
	          }
	        }
	      }
	    }
		} */
	});

	// Set start-up order of containers
    applicationContainer.addContainerDependencies(
		{
      	  container: envoyContainer,
		  condition: ecs.ContainerDependencyCondition.HEALTHY
		},
		{
      	  container: cwAgent,
	  	  condition: ecs.ContainerDependencyCondition.START
    	}
	);
	
	// ecsService: ecs.Ec2Service;
    this.ecsService = new ecs.FargateService(this, `${this.serviceName}-service`, {
      cluster: cluster,
      desiredCount: 2,
      taskDefinition: this.taskDefinition,
      cloudMapOptions: {
		//cloudMapNamespace: 
        dnsRecordType: servicediscovery.DnsRecordType.A,
        dnsTtl: cdk.Duration.seconds(10),
        failureThreshold: 2,
        //name: svcnamespace.toString()
      }
    });
	
    // Create a virtual node for the name service
    this.virtualNode = new appmesh.VirtualNode(this, `${this.serviceName}-virtual-node`, {
      mesh: mesh,
      virtualNodeName: this.serviceName,
      cloudMapService: this.ecsService.cloudMapService,
      listener: {
        portMapping: {
          port: this.portNumber,
          protocol: appmesh.Protocol.HTTP,
        },
        healthCheck: {
          healthyThreshold: 2,
		  interval: cdk.Duration.seconds(5), // minimum
          path: '/',
          port: this.portNumber,
          protocol: appmesh.Protocol.HTTP,
		  timeout: cdk.Duration.seconds(2), // minimum
          unhealthyThreshold: 2
        }
      },
    });

    // Create virtual service to make the virtual node accessible
    const virtualService = new appmesh.VirtualService(this, `${this.serviceName}-virtual-service`, {
      mesh: mesh,
      virtualNode: this.virtualNode,
	  virtualServiceName: `${this.serviceName}.internal`
      //virtualServiceName: `${this.serviceName}.${defaultCloudMapNamespace.namespaceName}`
    });
  } 	// end of Construuctor
  
  // Connect this mesh enabled service to another mesh enabled service.
  // This adjusts the security groups for both services so that they
  // can talk to each other. Also adjusts the virtual node for this service
  // so that its Envoy intercepts traffic that can be handled by the other
  // service's virtual service.
  connectToMeshService(appMeshService: any) {
    var trafficPort = new ec2.Port({
      protocol: ec2.Protocol.TCP,
      fromPort: appMeshService.portNumber,
      toPort: 3000,
	  stringRepresentation: 'Inbound traffic from the app mesh enabled'
    });

    // Adjust security group to allow traffic from this app mesh enabled service
    // to the other app mesh enabled service.
    this.ecsService.connections.allowTo(appMeshService.service, trafficPort, `Inbound traffic from the app mesh enabled ${this.serviceName}`);

    // Now adjust this app mesh service's virtual node to add a backend
    // that is the other service's virtual service
    this.virtualNode.addBackends(appMeshService.virtualService);
  }
}
// end of Class

/******************************************************************************
*************************** AppmeshBlogStack **********************************
******************************************************************************/

export class AppmeshBlogStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'GreetingVpc', { maxAzs: 2 });

    // Create an ECS cluster and CloudMap namespace
    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: vpc,
      defaultCloudMapNamespace: {
        name: 'internal',
        type: servicediscovery.NamespaceType.DNS_PRIVATE,
		vpc: vpc
      } 
    });

	// Create a CloudMap namespace 
	/* const namespace = new servicediscovery.PrivateDnsNamespace(this, 'internal-namespace', {
		vpc: vpc,
		name: 'internal'
	}); 
	const svcnamespace = namespace.createService('Svc'); */
	
    // Create an App Mesh
    const mesh = new appmesh.Mesh(this, 'app-mesh', {
      meshName: 'greeting-app-mesh',
      //egressFilter: appmesh.MeshFilterType.DROP_ALL
    });
	
    // Add capacity to cluster
    cluster.addCapacity('greeter-capacity', {
      instanceType: new ec2.InstanceType('t3.large'),
      minCapacity: 3,
      maxCapacity: 3,
	  keyName: 'aws-key',
    });

    const healthCheck = {
      command: [
        'curl localhost:3000'
      ],
      startPeriod: cdk.Duration.seconds(10),
      interval: cdk.Duration.seconds(5),
      timeout: cdk.Duration.seconds(2),
      retries: 3
    };

    const nameService = new Ec2AppMeshService(this, 'name', {
	//const nameService = new FargateAppMeshService(this, 'name', {
      cluster: cluster,
      mesh: mesh,
      portNumber: 3000,
      applicationContainer: {
        image: ecs.ContainerImage.fromRegistry('nathanpeck/name'),
        healthCheck: healthCheck,
        memoryLimitMiB: 128,
        logging: new ecs.AwsLogDriver({
          streamPrefix: 'app-mesh-name'
        }),
        environment: {
          PORT: '3000'
        }
      }
    });

    const greetingService = new Ec2AppMeshService(this, 'greeting', {
	//const greetingService = new FargateAppMeshService(this, 'greeting', {
      cluster: cluster,
      mesh: mesh,
	  //svcnamespace: svcnamespace,
      portNumber: 3000,
      applicationContainer: {
        image: ecs.ContainerImage.fromRegistry('nathanpeck/greeting'),
        healthCheck: healthCheck,
        memoryLimitMiB: 128,
        logging: new ecs.AwsLogDriver({
          streamPrefix: 'app-mesh-greeting'
        }),
        environment: {
          PORT: '3000'
        }
      }
    });

    const greeterService = new Ec2AppMeshService(this, 'greeter', {
	//const greeterService = new FargateAppMeshService(this, 'greeter', {
      cluster: cluster,
      mesh: mesh,
	  //svcnamespace: svcnamespace,
      portNumber: 3000,
      applicationContainer: {
        image: ecs.ContainerImage.fromRegistry('nathanpeck/greeter'),
        healthCheck: healthCheck,
        memoryLimitMiB: 128,
        logging: new ecs.AwsLogDriver({
          streamPrefix: 'app-mesh-greeter'
        }),
        environment: {
          GREETING_URL: 'http://greeting.internal:3000',
          NAME_URL: 'http://name.internal:3000',
          PORT: '3000'
        }
      }
    });

    greeterService.connectToMeshService(nameService);
    greeterService.connectToMeshService(greetingService);

    // Last but not least setup an internet facing load balancer for
    // exposing the public facing greeter service to the public.
    const externalLB = new elbv2.ApplicationLoadBalancer(this, 'external', {
      vpc: vpc,
      internetFacing: true
    });

    const externalListener = externalLB.addListener('PublicListener', { port: 80, open: true });

    externalListener.addTargets('greeter', {
      port: 80,
      targets: [greeterService.ecsService],
	  //targetType: elasticloadbalancingv2.TargetType.IP // Fargate
    });

	// Send LoadBalancer DNS name to output
    new cdk.CfnOutput(this, 'ExternalDNS', {
      exportName: 'greeter-app-external',
      value: externalLB.loadBalancerDnsName
    });
  }
}

/*
const app = new cdk.App();
const greeting = new AppmeshBlogStack(app, 'cw-app-mesh');

app.synth();
*/