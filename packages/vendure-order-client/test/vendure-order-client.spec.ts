import { DefaultLogger, LogLevel, mergeConfig } from '@vendure/core';
import {
  createTestEnvironment,
  registerInitializer,
  SimpleGraphQLClient,
  SqljsInitializer,
  testConfig,
} from '@vendure/testing';
import { TestServer } from '@vendure/testing/lib/test-server';
import { gql } from 'graphql-tag';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { VendureOrderClient, VendureOrderEvent } from '../src';
import {
  ActiveOrderFieldsFragment,
  CreateAddressInput,
  CreateCustomerInput,
  MolliePaymentIntentInput,
  PaymentInput,
  RegisterCustomerInput,
  Success,
} from '../src/graphql-generated-types';
import { initialData } from './initial-data';
import { testPaymentMethodHandler } from './test-payment-method-handler';
import { useStore } from '@nanostores/vue';
import { MapStore, listenKeys } from 'nanostores';
import { molliePaymentHandler } from '@vendure/payments-plugin/package/mollie/mollie.handler';
import { MolliePlugin } from '@vendure/payments-plugin/package/mollie/mollie.plugin';

const storage: any = {};
const window = {
  localStorage: {
    getItem: (key: string) => storage[key],
    setItem: (key: string, data: any) => (storage[key] = data),
    removeItem: (key: string) => (storage[key] = undefined),
  },
};
vi.stubGlobal('window', window);

// order.history is not included by default, so we use it to test additionalOrderFields
const additionalOrderFields = `
  fragment AdditionalOrderFields on Order {
    history {
      totalItems
    }
  }
`;
interface AdditionalOrderFields {
  history: { totalItems: number };
}

let client: VendureOrderClient<AdditionalOrderFields>;
let latestEmittedEvent: [string, VendureOrderEvent];

/**
 * T_2 is used as test product variant
 * T_1 is used as test order line
 */
describe(
  'Vendure order client',
  () => {
    let server: TestServer;
    const couponCodeName = 'couponCodeName';
    let activeOrderCode: string | undefined;
    let adminClient: SimpleGraphQLClient;
    let activeOrderStore: any;
    let currentUserStore: any;
    const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });

    beforeAll(async () => {
      registerInitializer('sqljs', new SqljsInitializer('__data__'));
      const config = mergeConfig(testConfig, {
        plugins: [
          MolliePlugin.init({
            vendureHost: 'my-vendure.io',
            useDynamicRedirectUrl: true,
          }),
        ],
        paymentOptions: {
          paymentMethodHandlers: [
            testPaymentMethodHandler,
            molliePaymentHandler,
          ],
        },
        authOptions: {
          requireVerification: false,
        },
        logger: new DefaultLogger({ level: LogLevel.Debug }),
      });
      ({ server, adminClient } = createTestEnvironment(config));
      await server.init({
        initialData,
        productsCsvPath: path.join(__dirname, './product-import.csv'),
      });
    }, 60000);

    type PromiseFn = () => Promise<any>;

    async function testActiveOrderLoadingState(
      awaitableFunction: PromiseFn
    ): Promise<any> {
      return await testLoadingState(awaitableFunction, client.$activeOrder);
    }

    async function testEligibleShippingMethodsLoadingState(
      awaitableFunction: PromiseFn,
      clientMethodName: string
    ): Promise<any> {
      let wasSetToTrue = false;
      let wasFinallySetToFalse = false;
      listenKeys(
        client.$eligibleShippingMethods,
        ['loading'],
        (currentEligibleShippingMethods) => {
          if (currentEligibleShippingMethods.loading) {
            wasSetToTrue = true;
          } else {
            if (wasSetToTrue) {
              wasFinallySetToFalse = true;
            }
          }
        }
      );
      await testActiveOrderLoadingState(awaitableFunction);
      expect(
        wasSetToTrue,
        `eligibleShippingMethods's 'loading' wasn't set to true when '${clientMethodName}' started running`
      ).toBe(true);
      setTimeout(() => {
        expect(
          wasFinallySetToFalse,
          `eligibleShippingMethods's 'loading' wasn't set to false when '${clientMethodName}' finished running`
        ).toBe(true);
      }, 1000);
    }

    async function testLoadingState(
      awaitableFunction: PromiseFn,
      store: MapStore
    ): Promise<any> {
      expect(store.value?.loading).toBe(false);
      const promise = awaitableFunction();
      expect(store.value?.loading).toBe(true);
      const result = await promise;
      expect(store.value?.loading).toBe(false);
      return result;
    }

    async function testCurrentUserLoadingState(
      awaitableFunction: PromiseFn
    ): Promise<any> {
      return await testLoadingState(awaitableFunction, client.$currentUser);
    }

    it('Starts the server successfully', async () => {
      expect(server.app.getHttpServer).toBeDefined();
    });

    it('Creates a promotion', async () => {
      await adminClient.asSuperAdmin();
      const { createPromotion } = await adminClient.query(
        gql`
          mutation CreatePromotionMutation($name: String!) {
            createPromotion(
              input: {
                enabled: true
                couponCode: $name
                translations: [{ languageCode: en, name: $name }]
                conditions: []
                actions: [
                  {
                    code: "order_fixed_discount"
                    arguments: [{ name: "discount", value: "10" }]
                  }
                ]
              }
            ) {
              ... on Promotion {
                id
                name
                couponCode
              }
              ... on ErrorResult {
                errorCode
              }
            }
          }
        `,
        { name: couponCodeName }
      );
      expect(createPromotion.name).toBe(couponCodeName);
      expect(createPromotion.couponCode).toBe(couponCodeName);
    });

    it('Creates a client', async () => {
      client = new VendureOrderClient<AdditionalOrderFields>(
        'http://localhost:3050/shop-api',
        'channel-token',
        additionalOrderFields
      );
      activeOrderStore = useStore(client.$activeOrder);
      currentUserStore = useStore(client.$currentUser);
      expect(client).toBeInstanceOf(VendureOrderClient);
      expect(activeOrderStore.value.data).toBeUndefined();
      expect(client.eventBus).toBeDefined();
      client.eventBus.on(
        '*',
        (eventType, e) => (latestEmittedEvent = [eventType, e])
      );
    });

    describe('Cart management', () => {
      it(
        'Adds an item to order',
        async () => {
          await testEligibleShippingMethodsLoadingState(
            async () => await client.addItemToOrder('T_2', 1),
            'addItemToOrder'
          );
          activeOrderCode = activeOrderStore?.value.data.code;
          expect(activeOrderStore?.value.data.lines[0].quantity).toBe(1);
          expect(activeOrderStore?.value.data.lines[0].productVariant.id).toBe(
            'T_2'
          );
        },
        { timeout: 10000 }
      );

      it('Emits "item-added" event, with quantity 1', async () => {
        const [eventType, event] = latestEmittedEvent;
        expect(eventType).toEqual('item-added');
        expect(event).toEqual({
          productVariantIds: ['T_2'],
          quantity: 1,
        });
      });

      it('Retrieves active order with specified additional fields', async () => {
        await client.getActiveOrder();
        expect(activeOrderStore.value?.data.lines[0].quantity).toBe(1);
        expect(activeOrderStore.value?.data.lines[0].productVariant.id).toBe(
          'T_2'
        );
        expect(activeOrderStore.value?.data.history.totalItems).toBe(1);
      });

      it('Increases quantity from 1 to 3', async () => {
        await testEligibleShippingMethodsLoadingState(
          async () => await client.adjustOrderLine('T_1', 3),
          'adjustOrderLine'
        );
        expect(activeOrderStore.value?.data.lines[0].quantity).toBe(3);
      });

      it('Emits "item-added" event, with quantity 2', async () => {
        const [eventType, event] = latestEmittedEvent;
        expect(eventType).toEqual('item-added');
        expect(event).toEqual({
          productVariantIds: ['T_2'],
          quantity: 2,
        });
      });

      it('Removes the order line', async () => {
        await testEligibleShippingMethodsLoadingState(
          async () => await client.removeOrderLine('T_1'),
          'removeOrderLine'
        );
        expect(activeOrderStore.value?.data.lines.length).toBe(0);
      });

      it('Emits "item-removed" event, with quantity 3', async () => {
        const [eventType, event] = latestEmittedEvent;
        expect(eventType).toEqual('item-removed');
        expect(event).toEqual({
          productVariantIds: ['T_2'],
          quantity: 3,
        });
      });

      it('Adds an item to order for the second time', async () => {
        await testEligibleShippingMethodsLoadingState(
          async () => await client.addItemToOrder('T_2', 1),
          'addItemToOrder'
        );
        expect(activeOrderStore.value?.data.lines[0].quantity).toBe(1);
        expect(activeOrderStore.value?.data.lines[0].productVariant.id).toBe(
          'T_2'
        );
      });

      it('Removes all order lines', async () => {
        await testEligibleShippingMethodsLoadingState(
          async () => await client.removeAllOrderLines(),
          'removeAllOrderLines'
        );
        expect(activeOrderStore.value?.data.lines.length).toBe(0);
      });

      it('Emits "item-removed" event, with quantity 1', async () => {
        const [eventType, event] = latestEmittedEvent;
        expect(eventType).toEqual('item-removed');
        expect(event).toEqual({
          productVariantIds: ['T_2'],
          quantity: 1,
        });
      });
    });

    describe('Guest checkout', () => {
      it('Adds an item to order', async () => {
        await testEligibleShippingMethodsLoadingState(
          async () => await client.addItemToOrder('T_2', 1),
          'addItemToOrder'
        );
        expect(activeOrderStore.value?.data.lines[0].quantity).toBe(1);
        expect(activeOrderStore.value?.data.lines[0].productVariant.id).toBe(
          'T_2'
        );
      });

      it('Applies invalid coupon', async () => {
        try {
          await testEligibleShippingMethodsLoadingState(
            async () => await client.applyCouponCode('fghj'),
            'applyCouponCode'
          );
        } catch (e: any) {
          expect(activeOrderStore.value.error.errorCode).toBe(
            'COUPON_CODE_INVALID_ERROR'
          );
        }
      });

      it('Applies valid coupon', async () => {
        await testEligibleShippingMethodsLoadingState(
          async () => await client.applyCouponCode(couponCodeName),
          'applyCouponCode'
        );
        expect(
          (activeOrderStore.value.data as ActiveOrderFieldsFragment)
            ?.couponCodes?.length
        ).toEqual(1);
      });

      it('Emits "coupon-code-applied" event', async () => {
        const [eventType, event] = latestEmittedEvent;
        expect(eventType).toEqual('coupon-code-applied');
        expect(event).toEqual({
          couponCode: couponCodeName,
        });
      });

      it('Removes coupon', async () => {
        await testEligibleShippingMethodsLoadingState(
          async () => await client.removeCouponCode(couponCodeName),
          'removeCouponCode'
        );
        expect(activeOrderStore.value.data?.couponCodes?.length).toEqual(0);
      });

      it('Emits "coupon-code-removed" event', async () => {
        const [eventType, event] = latestEmittedEvent;
        expect(eventType).toEqual('coupon-code-removed');
        expect(event).toEqual({
          couponCode: couponCodeName,
        });
      });

      it('Adds customer', async () => {
        const createCustomerInput: CreateCustomerInput = {
          emailAddress: 'example@gmail.com',
          firstName: 'Mein',
          lastName: 'Zohn',
        };
        await testEligibleShippingMethodsLoadingState(
          async () => await client.setCustomerForOrder(createCustomerInput),
          'setCustomerForOrder'
        );
        const customer = (
          activeOrderStore.value.data as ActiveOrderFieldsFragment
        ).customer;
        if (!customer) {
          throw Error('Failed to create customer');
        }
        expect(customer.emailAddress).toEqual(createCustomerInput.emailAddress);
        expect(customer.firstName).toEqual(createCustomerInput.firstName);
        expect(customer.lastName).toEqual(createCustomerInput.lastName);
      });

      it('Adds shipping address', async () => {
        const addShippingAddressInput: CreateAddressInput = {
          streetLine1: ' Stree Line in Ethiopia',
          countryCode: 'GB',
        };
        await testEligibleShippingMethodsLoadingState(
          async () =>
            await client.setOrderShippingAddress(addShippingAddressInput),
          'setOrderShippingAddress'
        );
        const shippingAddress = (
          activeOrderStore.value.data as ActiveOrderFieldsFragment
        ).shippingAddress;
        if (!shippingAddress) {
          throw Error('Failed to set shipping address');
        }
        expect(shippingAddress.country).toEqual(
          regionNames.of(addShippingAddressInput.countryCode)
        );
        expect(shippingAddress.streetLine1).toEqual(
          addShippingAddressInput.streetLine1
        );
      });

      it('Adds billing address', async () => {
        const addBillingAddressInput: CreateAddressInput = {
          streetLine1: 'ANother Stree Line in Ethiopia',
          countryCode: 'GB',
        };
        await testEligibleShippingMethodsLoadingState(
          async () => await client.addBillingAddress(addBillingAddressInput),
          'addBillingAddress'
        );
        const billingAddress = (
          activeOrderStore.value.data as ActiveOrderFieldsFragment
        ).billingAddress;
        if (!billingAddress) {
          throw Error('Failed to set billing address');
        }
        expect(billingAddress.country).toEqual(
          regionNames.of(addBillingAddressInput.countryCode)
        );
        expect(billingAddress.streetLine1).toEqual(
          addBillingAddressInput.streetLine1
        );
      });

      it('Sets shipping method', async () => {
        await testEligibleShippingMethodsLoadingState(
          async () => await client.setOrderShippingMethod(['T_1']),
          'setOrderShippingMethod'
        );
        expect(
          (activeOrderStore.value.data as ActiveOrderFieldsFragment)
            .shippingLines?.length
        ).toEqual(1);
        expect(
          (
            activeOrderStore.value.data as ActiveOrderFieldsFragment
          ).shippingLines?.find((s) => s.shippingMethod?.id === 'T_1')
        ).toBeDefined();
      });

      it('Transitions order to arranging payment state', async () => {
        await testActiveOrderLoadingState(
          async () => await client.transitionOrderToState('ArrangingPayment')
        );
        expect(
          (activeOrderStore.value.data as ActiveOrderFieldsFragment).state
        ).toBe('ArrangingPayment');
      });

      it('Adds payment', async () => {
        const addPaymentInput: PaymentInput = {
          method: 'test-payment',
          metadata: {
            id: 0,
          },
        };
        await testActiveOrderLoadingState(
          async () => await client.addPayment(addPaymentInput)
        );
        expect(
          (activeOrderStore.value.data as ActiveOrderFieldsFragment).payments
            ?.length
        ).toBeGreaterThan(0);
        const testPayment = (
          activeOrderStore.value.data as ActiveOrderFieldsFragment
        ).payments?.find((p) => p.method === addPaymentInput.method);
        expect(testPayment?.metadata.public.id).toEqual(
          addPaymentInput.metadata.id
        );
      });

      it('Gets order by code', async () => {
        if (!activeOrderCode) {
          throw Error('Active order code is not defined');
        }
        await client.getOrderByCode(activeOrderCode);
        expect(activeOrderCode).toEqual(activeOrderStore.value.data.code);
      });
    });

    const createNewCustomerInput: RegisterCustomerInput = {
      emailAddress: `test${Math.random()}@xyz.com`,
      password: '1qaz2wsx',
      firstName: 'Hans',
      lastName: 'Miller',
    };

    describe('Registered customer checkout', () => {
      it('Register as customer', async () => {
        const result = await client.registerCustomerAccount(
          createNewCustomerInput
        );
        expect((result as Success)?.success).toBe(true);
      });

      it('Login with the new customer', async () => {
        await testCurrentUserLoadingState(
          async () =>
            await client.login(
              createNewCustomerInput.emailAddress,
              createNewCustomerInput.password as string
            )
        );
        expect(currentUserStore.value.data.identifier).toBe(
          createNewCustomerInput.emailAddress
        );
      });

      it('Add item to cart as the new customer', async () => {
        await testEligibleShippingMethodsLoadingState(
          async () => await client.addItemToOrder('T_1', 2),
          'addItemToOrder'
        );
        expect(activeOrderStore.value.data.customer.emailAddress).toBe(
          createNewCustomerInput.emailAddress
        );
        expect(activeOrderStore.value.data.lines.length).toBe(1);
        expect(activeOrderStore.value.data.lines[0].quantity).toBe(2);
        expect(activeOrderStore.value.data.lines[0].productVariant.id).toBe(
          'T_1'
        );
      });
    });

    describe('Mollie payment', () => {
      it('Prepares an active order', async () => {
        await client.addItemToOrder('T_1', 1);
        await client.setCustomerForOrder({
          emailAddress: createNewCustomerInput.emailAddress,
          firstName: createNewCustomerInput.firstName as string,
          lastName: createNewCustomerInput.lastName as string,
        });
        await client.setOrderShippingAddress({
          fullName: 'name',
          streetLine1: '12 the street',
          city: 'Leeuwarden',
          postalCode: '123456',
          countryCode: 'AT',
        });
        await client.setOrderShippingMethod([
          client.$eligibleShippingMethods.value?.data?.[0]?.id as string,
        ]);
      });

      it('Should get Mollie payment methods', async () => {
        let errorMessage: any | undefined;
        try {
          await client.getMolliePaymentMethods({
            paymentMethodCode: 'mollie-payment',
          });
        } catch (e: any) {
          errorMessage = e.message;
        }
        expect(errorMessage).toContain(
          'No apiKey configured for payment method mollie-payment'
        );
      });

      it('Should create Mollie payment intent as authenticated customer', async () => {
        let errorMessage: any | undefined;
        const createMolliePaymentIntentInput: MolliePaymentIntentInput = {
          redirectUrl: 'https://remix-storefront.vendure.io',
          paymentMethodCode: 'mollie-payment',
          molliePaymentMethodCode: 'ideal',
        };
        try {
          await client.createMolliePaymentIntent(
            createMolliePaymentIntentInput
          );
        } catch (e: any) {
          errorMessage = e.message;
        }
        expect(errorMessage).toContain(
          'Paymentmethod mollie-payment has no apiKey configured'
        );
      });
    });

    afterAll(async () => {
      await server.destroy();
    }, 100000);
  },
  { timeout: 10000 }
);
