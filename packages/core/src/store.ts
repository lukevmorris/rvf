import { setPath, getPath } from "set-get";
import { create } from "zustand";
import { immer } from "./immer";
import { setFormControlValue, focusFirst } from "./dom";
import {
  FieldValues,
  SubmitStatus,
  ValidationBehavior,
  ValidationBehaviorConfig,
  Validator,
} from "./types";
import { GenericObject } from "./native-form-data/flatten";
import { MultiValueMap } from "./native-form-data/MultiValueMap";

export const createRefStore = () => {
  const elementRefs = new MultiValueMap<string, HTMLElement>();
  const symbolMaps = new Map<symbol, HTMLElement>();
  return {
    getRefs: (fieldName: string) => elementRefs.getAll(fieldName),
    removeRef: (fieldName: string, symbol?: symbol) => {
      if (symbol) {
        const el = symbolMaps.get(symbol);
        symbolMaps.delete(symbol);
        if (!el)
          throw new Error("Ref symbol not found. This is likely a bug in RVF");
        elementRefs.remove(fieldName, el);
        return;
      }
      elementRefs.delete(fieldName);
    },
    setRef: (fieldName: string, ref: HTMLElement, symbol?: symbol) => {
      if (symbol) symbolMaps.set(symbol, ref);
      elementRefs.add(fieldName, ref);
    },
    forEach: (callback: (fieldName: string, ref: HTMLElement | null) => void) =>
      [...elementRefs.entries()].forEach(([fieldName, refs]) =>
        refs.forEach((ref) => callback(fieldName, ref)),
      ),
    all: () => [...elementRefs.entries()],
  };
};
export type RefStore = ReturnType<typeof createRefStore>;

type StoreState = {
  values: FieldValues;
  defaultValues: FieldValues;
  touchedFields: Record<string, boolean>;
  dirtyFields: Record<string, boolean>;
  validationErrors: Record<string, string>;
  submitStatus: SubmitStatus;
  fieldArrayKeys: Record<string, Array<string>>;
  validationBehaviorConfig: ValidationBehaviorConfig;
  submitSource: "state" | "dom";
};

type StoreEvents = {
  onFieldChange: (
    fieldName: string,
    value: unknown,
    validationBehaviorConfig?: ValidationBehaviorConfig,
  ) => void;
  onFieldBlur: (
    fieldName: string,
    validationBehaviorConfig?: ValidationBehaviorConfig,
  ) => void;
  onSubmit: (submitterData?: Record<string, string>) => void;
};

type StoreActions = {
  setValue: (fieldName: string, value: unknown) => void;
  setTouched: (fieldName: string, value: boolean) => void;
  setDirty: (fieldName: string, value: boolean) => void;
  setError: (fieldName: string, value: string | null) => void;

  setAllValues: (data: FieldValues) => void;
  setAllTouched: (data: Record<string, boolean>) => void;
  setAllDirty: (data: Record<string, boolean>) => void;
  setAllErrors: (data: Record<string, string>) => void;

  shouldValidate: (
    eventType: ValidationBehavior,
    fieldName: string,
    validationBehaviorConfig?: ValidationBehaviorConfig,
  ) => boolean;
  getValidationErrors: (
    nextValues?: FieldValues,
  ) => Promise<Record<string, string>>;
  validate: () => Promise<Record<string, string>>;

  syncOptions: (opts: {
    submitSource: "state" | "dom";
    validationBehaviorConfig?: ValidationBehaviorConfig | undefined;
  }) => void;

  reset: (nextValues?: FieldValues) => void;
  resetField: (fieldName: string, nextValue?: unknown) => void;

  getFieldArrayKeys: (fieldName: string) => Array<string>;
  arrayPush: (fieldName: string, value: unknown) => void;
  arrayPop: (fieldName: string) => void;
  arrayShift: (fieldName: string) => void;
  arrayUnshift: (fieldName: string, value: unknown) => void;
  arrayInsert: (fieldName: string, index: number, value: unknown) => void;
  arrayMove: (fieldName: string, fromIndex: number, toIndex: number) => void;
  arrayRemove: (fieldName: string, index: number) => void;
  arraySwap: (fieldName: string, fromIndex: number, toIndex: number) => void;
  arrayReplace: (fieldName: string, index: number, value: unknown) => void;
};

export type FormStoreValue = StoreState & StoreEvents & StoreActions;

type StateSubmitter = (data: any) => void | Promise<void>;
type DomSubmitter = (data: any, formData: FormData) => void | Promise<void>;
export type MutableImplStore = {
  validator: Validator<any>;
  onSubmit: StateSubmitter | DomSubmitter;
};

const defaultValidationBehaviorConfig: ValidationBehaviorConfig = {
  initial: "onSubmit",
  whenTouched: "onSubmit",
  whenSubmitted: "onChange",
};

export type FormStoreInit = {
  defaultValues: Record<PropertyKey, unknown>;
  transientFieldRefs: RefStore;
  controlledFieldRefs: RefStore;
  formRef: { current: HTMLFormElement | null };
  submitSource: "state" | "dom";
  mutableImplStore: MutableImplStore;
  validationBehaviorConfig?: ValidationBehaviorConfig;
};

const genKey = () => `${Math.round(Math.random() * 10_000)}-${Date.now()}`;

export const renameFlatFieldStateKeys = <Obj extends Record<string, any>>(
  obj: Obj,
  path: string,
  updater: (key: string) => string,
) => {
  const newObj: Record<string, any> = {};
  const removeKeys: string[] = [];

  for (const [key, value] of Object.entries(obj)) {
    if (key.startsWith(path)) {
      newObj[updater(key)] = value;
      removeKeys.push(key);
    }
  }

  removeKeys.forEach((key) => delete obj[key]);
  Object.assign(obj, newObj);
};

export const deleteFieldsWithPrefix = (
  prefixObjects: Record<string, any>[],
  path: string,
) => {
  for (const obj of prefixObjects) {
    for (const [key, value] of Object.entries(obj)) {
      if (key.startsWith(path)) {
        delete obj[key];
      }
    }
  }
};

export const moveFieldArrayKeys = (
  objs: Record<string, any>[],
  fieldName: string,
  updater: (index: number) => number,
) => {
  objs.forEach((obj) => {
    renameFlatFieldStateKeys(obj, fieldName, (key) => {
      if (key === fieldName) return key;
      const suffix = key.replace(`${fieldName}.`, "");
      const parts = suffix.split(".");
      const index = Number(parts.shift());
      if (Number.isNaN(index))
        throw new Error("Attempted to update a non-array field");
      const newIndex = updater(index);
      return [fieldName, newIndex, ...parts].join(".");
    });
  });
};

export const createFormStateStore = ({
  defaultValues,
  controlledFieldRefs,
  transientFieldRefs,
  mutableImplStore,
  formRef,
  submitSource,
  validationBehaviorConfig = defaultValidationBehaviorConfig,
}: FormStoreInit) =>
  create<FormStoreValue>()(
    immer((set, get) => ({
      /////// State
      values: defaultValues,
      defaultValues,
      touchedFields: {},
      dirtyFields: {},
      validationErrors: {},
      fieldArrayKeys: {},
      submitStatus: "idle",
      validationBehaviorConfig,
      submitSource,

      /////// Validation
      shouldValidate: (eventType, fieldName, behaviorOverride) => {
        if (eventType === "onSubmit") return true;

        const config = behaviorOverride ?? get().validationBehaviorConfig;
        const currentValidationBehavior =
          get().submitStatus !== "idle"
            ? config.whenSubmitted
            : get().touchedFields[fieldName]
              ? config.whenTouched
              : config.initial;

        if (eventType === "onBlur")
          return (
            currentValidationBehavior === "onBlur" ||
            currentValidationBehavior === "onChange"
          );

        return currentValidationBehavior === "onChange";
      },

      getValidationErrors: async (nextValues = get().values) => {
        const result = await mutableImplStore.validator.validate(nextValues);
        if (result.error) return result.error.fieldErrors;
        return {};
      },

      validate: async () => {
        const errors = await get().getValidationErrors();
        set((state) => {
          state.validationErrors = errors;
        });
        return errors;
      },

      /////// Events
      onFieldChange: (fieldName, value, validationBehaviorConfig) => {
        set((state) => {
          setPath(state.values, fieldName, value);
          state.dirtyFields[fieldName] = true;
        });

        if (
          get().shouldValidate("onChange", fieldName, validationBehaviorConfig)
        ) {
          get().validate();
        } else {
          get().setError(fieldName, null);
        }
      },

      onFieldBlur: (fieldName, validationBehaviorConfig) => {
        set((state) => {
          state.touchedFields[fieldName] = true;
        });

        if (
          get().shouldValidate("onBlur", fieldName, validationBehaviorConfig)
        ) {
          get().validate();
        }
      },

      onSubmit: async (submitterData) => {
        set((state) => {
          state.submitStatus = "submitting";
        });

        const getValues = (): GenericObject | FormData => {
          if (get().submitSource === "state") return get().values;

          const form = formRef.current;
          if (!form)
            throw new Error(
              "`submitSource` is set to `dom`, but no form is registered with RVF.",
            );

          const formData = new FormData(form);
          if (submitterData) {
            Object.entries(submitterData).forEach(([key, value]) => {
              formData.append(key, value);
            });
          }
          return formData;
        };

        const rawValues = getValues();
        const result = await mutableImplStore.validator.validate(rawValues);

        if (result.error) {
          set((state) => {
            state.submitStatus = "error";
            state.validationErrors = result.error.fieldErrors;
          });
          const elementsWithErrors = Object.keys(result.error.fieldErrors)
            .flatMap((fieldName) => [
              ...transientFieldRefs.getRefs(fieldName),
              ...controlledFieldRefs.getRefs(fieldName),
            ])
            .filter((val): val is NonNullable<typeof val> => val != null);
          focusFirst(elementsWithErrors);

          return;
        }

        set((state) => {
          state.validationErrors = {};
        });

        try {
          if (get().submitSource === "state") {
            await (mutableImplStore.onSubmit as StateSubmitter)(result.data);
          } else
            await (mutableImplStore.onSubmit as DomSubmitter)(
              result.data,
              rawValues as FormData, // should be FormData in this case
            );
          set((state) => {
            state.submitStatus = "success";
          });
        } catch (err) {
          set((state) => {
            state.submitStatus = "error";
          });
        }
      },

      /////// Actions
      syncOptions: ({
        submitSource,
        validationBehaviorConfig = defaultValidationBehaviorConfig,
      }) => {
        set((state) => {
          state.submitSource = submitSource;
          state.validationBehaviorConfig = validationBehaviorConfig;
        });
      },

      setValue: (fieldName, value) => {
        set((state) => {
          if (fieldName) setPath(state.values, fieldName, value);
          else state.values = value as any;
        });

        transientFieldRefs.getRefs(fieldName).forEach((ref) => {
          setFormControlValue(ref, value);
        });
      },

      setAllValues: (data) => {
        set((state) => {
          state.values = data;
        });
      },

      setTouched: (fieldName, value) => {
        set((state) => {
          state.touchedFields[fieldName] = value;
        });
      },

      setDirty: (fieldName, value) => {
        set((state) => {
          state.dirtyFields[fieldName] = value;
        });
      },

      setError: (fieldName, value) => {
        set((state) => {
          if (value == null) delete state.validationErrors[fieldName];
          else state.validationErrors[fieldName] = value;
        });
      },

      setAllTouched: (data) => {
        set((state) => {
          state.touchedFields = data;
        });
      },

      setAllDirty: (data) => {
        set((state) => {
          state.dirtyFields = data;
        });
      },

      setAllErrors: (data) => {
        set((state) => {
          state.validationErrors = data;
        });
      },

      ///////// Other actions
      reset: (nextValues = get().defaultValues) => {
        set((state) => {
          state.values = nextValues;
          state.defaultValues = nextValues;
          state.touchedFields = {};
          state.dirtyFields = {};
          state.validationErrors = {};
          state.fieldArrayKeys = {};
          state.submitStatus = "idle";
        });

        transientFieldRefs.forEach((fieldName, ref) => {
          if (!ref) return;
          setFormControlValue(ref, getPath(nextValues, fieldName));
        });
      },

      resetField: (
        fieldName,
        nextValue = getPath(get().defaultValues, fieldName),
      ) => {
        set((state) => {
          setPath(state.values, fieldName, nextValue);
          deleteFieldsWithPrefix(
            [
              state.touchedFields,
              state.validationErrors,
              state.dirtyFields,
              state.fieldArrayKeys,
            ],
            fieldName,
          );
        });

        transientFieldRefs.forEach((fieldName, ref) => {
          if (!ref) return;
          setFormControlValue(ref, nextValue);
        });
      },

      ///////// Arrays
      getFieldArrayKeys: (fieldName) => {
        const currentKeys = get().fieldArrayKeys[fieldName];
        if (currentKeys) return currentKeys;

        const value = getPath(get().values, fieldName) as unknown;
        if (!Array.isArray(value)) {
          console.warn(
            "Tried to treat a non-array as an array. Make sure you used the correct field name and set a default value.",
          );
          return [];
        }

        const newKeys = value.map(() => genKey());

        queueMicrotask(() => {
          set((state) => {
            state.fieldArrayKeys[fieldName] = newKeys;
          });
        });

        return newKeys;
      },

      arrayPush: (fieldName, value) => {
        set((state) => {
          const val = state.values[fieldName];
          if (!Array.isArray(val)) throw new Error("Can't push to a non-array");
          val.push(value);

          state.fieldArrayKeys[fieldName]?.push(genKey());
          // no change to touched, dirty, or validationErrors
        });
      },
      arrayPop: (fieldName) => {
        set((state) => {
          const val = state.values[fieldName];
          if (!Array.isArray(val))
            throw new Error("Can't pop from a non-array");
          const numItems = val.length;
          val.pop();
          state.fieldArrayKeys[fieldName]?.pop();
          deleteFieldsWithPrefix(
            [state.touchedFields, state.validationErrors, state.dirtyFields],
            `${fieldName}.${numItems - 1}`,
          );
        });
      },
      arrayShift: (fieldName) => {
        set((state) => {
          const val = state.values[fieldName];
          if (!Array.isArray(val))
            throw new Error("Can't shift from a non-array");
          val.shift();
          state.fieldArrayKeys[fieldName]?.shift();

          // TODO: need to adjust touched, dirty, and validationErrors
          deleteFieldsWithPrefix(
            [state.touchedFields, state.validationErrors, state.dirtyFields],
            `${fieldName}.0`,
          );
          moveFieldArrayKeys(
            [state.touchedFields, state.validationErrors, state.dirtyFields],
            fieldName,
            (index) => index - 1,
          );
        });
      },
      arrayUnshift: (fieldName, value) => {
        set((state) => {
          const val = state.values[fieldName];
          if (!Array.isArray(val))
            throw new Error("Can't unshift to a non-array");

          val.unshift(value);
          state.fieldArrayKeys[fieldName]?.unshift(genKey());
          moveFieldArrayKeys(
            [state.touchedFields, state.validationErrors, state.dirtyFields],
            fieldName,
            (index) => index + 1,
          );
        });
      },
      arrayInsert: (fieldName, insertAtIndex, value) => {
        set((state) => {
          const val = state.values[fieldName];
          if (!Array.isArray(val))
            throw new Error("Can't insert to a non-array");

          val.splice(insertAtIndex, 0, value);
          state.fieldArrayKeys[fieldName]?.splice(insertAtIndex, 0, genKey());
          moveFieldArrayKeys(
            [state.touchedFields, state.validationErrors, state.dirtyFields],
            fieldName,
            (index) => (index >= insertAtIndex ? index + 1 : index),
          );
        });
      },
      arrayMove: (fieldName, fromIndex, toIndex) => {
        set((state) => {
          const val = state.values[fieldName];
          if (!Array.isArray(val))
            throw new Error("Can't move from a non-array");

          const item = val.splice(fromIndex, 1)[0];
          val.splice(toIndex, 0, item);

          if (state.fieldArrayKeys[fieldName]) {
            const [fromKey] = state.fieldArrayKeys[fieldName].splice(
              fromIndex,
              1,
            );
            state.fieldArrayKeys[fieldName].splice(toIndex, 0, fromKey);
          }

          moveFieldArrayKeys(
            [state.touchedFields, state.validationErrors, state.dirtyFields],
            fieldName,
            (index) => {
              if (index === fromIndex) return toIndex;
              let res = index;
              if (index > fromIndex) res--;
              if (index >= toIndex) res++;
              return res;
            },
          );
        });
      },
      arrayRemove: (fieldName, removeIndex) => {
        set((state) => {
          const val = state.values[fieldName];
          if (!Array.isArray(val))
            throw new Error("Can't remove from a non-array");

          val.splice(removeIndex, 1);
          state.fieldArrayKeys[fieldName]?.splice(removeIndex, 1);

          deleteFieldsWithPrefix(
            [state.touchedFields, state.validationErrors, state.dirtyFields],
            `${fieldName}.${removeIndex}`,
          );
          moveFieldArrayKeys(
            [state.touchedFields, state.validationErrors, state.dirtyFields],
            fieldName,
            (index) => (index > removeIndex ? index - 1 : index),
          );
        });
      },
      arraySwap: (fieldName, fromIndex, toIndex) => {
        set((state) => {
          const val = state.values[fieldName];
          if (!Array.isArray(val))
            throw new Error("Can't swap from a non-array");

          const item = val[fromIndex];
          val[fromIndex] = val[toIndex];
          val[toIndex] = item;

          if (state.fieldArrayKeys[fieldName]) {
            const keys = state.fieldArrayKeys[fieldName];
            const item = keys[fromIndex];
            keys[fromIndex] = keys[toIndex];
            keys[toIndex] = item;
          }

          moveFieldArrayKeys(
            [state.touchedFields, state.validationErrors, state.dirtyFields],
            fieldName,
            (index) => {
              if (index === fromIndex) return toIndex;
              if (index === toIndex) return fromIndex;
              return index;
            },
          );
        });
      },
      arrayReplace: (fieldName, index, value) => {
        set((state) => {
          const val = state.values[fieldName];
          if (!Array.isArray(val))
            throw new Error("Can't replace from a non-array");

          val[index] = value;
          state.fieldArrayKeys[fieldName][index] = genKey();
          // Treat a replacement as a reset / new field at the same index.
          deleteFieldsWithPrefix(
            [state.touchedFields, state.validationErrors, state.dirtyFields],
            `${fieldName}.${index}`,
          );
        });
      },
    })),
  );
