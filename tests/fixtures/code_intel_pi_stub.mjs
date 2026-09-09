export const Type = {
  Object: properties => ({ type: "object", properties }),
  String: options => ({ type: "string", ...options }),
  Integer: options => ({ type: "integer", ...options }),
  Optional: value => ({ ...value, optional: true }),
};
export const StringEnum = values => ({ type: "string", enum: values });
