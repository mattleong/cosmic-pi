export const SUPERVISOR_MCP_REGISTRATION = "pi_subagents_supervisor" as const;

export const SUPERVISOR_MCP_MESSAGE_TOOL_NAMES = [
  "supervisor_progress",
  "supervisor_warning",
  "supervisor_question",
] as const;
export const SUPERVISOR_MCP_TOOL_NAMES = [
  ...SUPERVISOR_MCP_MESSAGE_TOOL_NAMES,
  "supervisor_submit_report",
] as const;
export const SUPERVISOR_MCP_MESSAGE_ARGUMENT_KEYS = ["message"] as const;
export const SUPERVISOR_MCP_REPORT_ARGUMENT_KEYS = ["delivery_id", "report"] as const;

export interface SupervisorMcpMessageArguments {
  readonly message: string;
}

export interface SupervisorMcpReportArguments {
  readonly delivery_id: string;
  readonly report: string;
}

export interface SupervisorMcpToolArgumentsByName {
  readonly supervisor_progress: SupervisorMcpMessageArguments;
  readonly supervisor_warning: SupervisorMcpMessageArguments;
  readonly supervisor_question: SupervisorMcpMessageArguments;
  readonly supervisor_submit_report: SupervisorMcpReportArguments;
}

export const MAX_SUPERVISOR_MCP_MESSAGE_CHARS = 16_384;
export const MAX_SUPERVISOR_MCP_REPORT_CHARS = 32_768;
export const MAX_SUPERVISOR_MCP_DELIVERY_ID_CHARS = 256;
export const SUPERVISOR_MCP_NONBLANK_PATTERN_SOURCE = ".*\\S.*";
export const SUPERVISOR_MCP_DELIVERY_ID_PATTERN_SOURCE = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$";

const NONBLANK_PATTERN = new RegExp(SUPERVISOR_MCP_NONBLANK_PATTERN_SOURCE);
const DELIVERY_ID_PATTERN = new RegExp(SUPERVISOR_MCP_DELIVERY_ID_PATTERN_SOURCE);

const isStringValue = <ValueInput>(value: ValueInput): value is ValueInput & string => {
  try {
    return Object.getPrototypeOf(value) === String.prototype && Object(value) !== value;
  } catch {
    return false;
  }
};

const exactObjectKeys = <ValueInput>(
  value: ValueInput,
  keys: ReadonlyArray<string>,
): value is ValueInput & object => {
  try {
    const objectValue = Object(value);
    const prototype = Object.getPrototypeOf(objectValue);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const actual = Object.keys(objectValue);
    return actual.length === keys.length && keys.every((key) => actual.includes(key));
  } catch {
    return false;
  }
};

export const isSupervisorMcpNonblankString = <ValueInput>(
  value: ValueInput,
  maximum: number,
): value is ValueInput & string =>
  isStringValue(value) && value.length <= maximum && NONBLANK_PATTERN.test(value);

export const isSupervisorMcpMessage = <ValueInput>(
  value: ValueInput,
): value is ValueInput & string =>
  isSupervisorMcpNonblankString(value, MAX_SUPERVISOR_MCP_MESSAGE_CHARS);

export const isSupervisorMcpReport = <ValueInput>(
  value: ValueInput,
): value is ValueInput & string =>
  isSupervisorMcpNonblankString(value, MAX_SUPERVISOR_MCP_REPORT_CHARS);

export const isSupervisorMcpDeliveryId = <ValueInput>(
  value: ValueInput,
): value is ValueInput & string =>
  isStringValue(value) &&
  value.length <= MAX_SUPERVISOR_MCP_DELIVERY_ID_CHARS &&
  DELIVERY_ID_PATTERN.test(value);

export const isSupervisorMcpMessageArguments = <ValueInput>(
  value: ValueInput,
): value is ValueInput & SupervisorMcpMessageArguments => {
  if (!exactObjectKeys(value, SUPERVISOR_MCP_MESSAGE_ARGUMENT_KEYS)) return false;
  try {
    return isSupervisorMcpMessage(Object.getOwnPropertyDescriptor(value, "message")?.value);
  } catch {
    return false;
  }
};

export const isSupervisorMcpReportArguments = <ValueInput>(
  value: ValueInput,
): value is ValueInput & SupervisorMcpReportArguments => {
  if (!exactObjectKeys(value, SUPERVISOR_MCP_REPORT_ARGUMENT_KEYS)) return false;
  try {
    return (
      isSupervisorMcpDeliveryId(Object.getOwnPropertyDescriptor(value, "delivery_id")?.value) &&
      isSupervisorMcpReport(Object.getOwnPropertyDescriptor(value, "report")?.value)
    );
  } catch {
    return false;
  }
};
