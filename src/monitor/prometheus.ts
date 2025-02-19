import { Gauge, Metric, Pushgateway, Registry } from "prom-client";
import { AttLogger, logException } from "../utils/logging/logger";

/**
 * Prometheus interface.
 */
export class Prometheus {
  logger: AttLogger;

  register: Registry;
  gateway: Pushgateway;

  metrics = new Map<string, Metric>();

  constructor(logger) {
    this.logger = logger;
    this.register = new Registry();
  }

  /**
   * Connect to Prometheus push gateway
   * @param url
   */
  connectPushgateway(url: string) {
    try {
      this.gateway = new Pushgateway(url, [], this.register);
    } catch (error) {
      logException(error, `Prometheus.createPushgateway`);
    }
  }

  /**
   * Send registered metric to connected push gateway.
   * @param jobName
   */
  sendPushGatewayMetric(jobName: string) {
    try {
      this.gateway
        .push({ jobName: jobName })
        .then(({ resp, body }) => {
          console.log(`Body: ${body}`);
          console.log(`Response status: ${resp.toString()}`);
        })
        .catch((err) => {
          console.log(`Error: ${err}`);
        });
    } catch (error) {
      logException(error, `Prometheus.push`);
    }
  }

  /**
   * Get all registered Prometheus metrics.
   * @returns
   */
  async getMetrics(): Promise<string> {
    return await this.register.metrics();
  }

  /**
   * Set gauge data, create and register it if it does not exists.
   * @param name
   * @param help
   * @param labels
   * @param value
   */
  setGauge(name: string, help: string, labels: string, value: number) {
    try {
      const cleanName = name.toLowerCase().replaceAll("-", "_").replaceAll(".", "_").replaceAll("/", "_").replaceAll(" ", "").replaceAll("%", "percent");
      const cleanLabels = labels.toLowerCase().replaceAll("-", "_").replaceAll(".", "_").replaceAll("/", "_").replaceAll(" ", "").replaceAll("%", "percent");

      let gauge = <Gauge>this.metrics.get(cleanName);

      if (!help) {
        help = "no help provided";
      }

      if (!gauge) {
        this.logger.debug(`register prometheus gauge '^g${cleanName}^^ (${labels}) (${help})'`);

        gauge = new Gauge({
          name: cleanName,
          help: help,
          registers: [this.register],
          labelNames: cleanLabels ? [cleanLabels] : [],
        });
        this.register.registerMetric(gauge);

        this.metrics.set(cleanName, gauge);
      }

      gauge.set(+value);
    } catch (error) {
      logException(`registerGauge`, error);
    }
  }
}
