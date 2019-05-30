import { Op } from 'sequelize';
import { EventEmitter } from 'events';
import Errors from './Errors';
import Logger from '../Logger';
import Swap from '../db/models/Swap';
import Pair from '../db/models/Pair';
import SwapRepository from './SwapRepository';
import PairRepository from './PairRepository';
import BoltzClient from '../boltz/BoltzClient';
import FeeProvider from '../rates/FeeProvider';
import RateProvider from '../rates/RateProvider';
import ReverseSwap from '../db/models/ReverseSwap';
import { encodeBip21 } from './PaymentRequestUtils';
import ReverseSwapRepository from './ReverseSwapRepository';
import { SwapUpdateEvent, ServiceWarning } from '../consts/Enums';
import { SwapUpdate, CurrencyConfig, PairConfig } from '../consts/Types';
import { OrderSide, OutputType, CurrencyInfo } from '../proto/boltzrpc_pb';
import { splitPairId, stringify, generateId, mapToObject, feeMapToObject, getAmountOfInvoice } from '../Utils';

type PairType = {
  id: string;
  base: string;
  quote: string;
};

interface Service {
  on(event: 'swap.update', listener: (id: string, message: SwapUpdate) => void): this;
  emit(event: 'swap.update', id: string, message: SwapUpdate): boolean;

  on(event: 'swap.successful', listener: (swap: Swap | ReverseSwap) => void): this;
  emit(event: 'swap.successful', swap: Swap | ReverseSwap): boolean;

  on(event: 'swap.failed', listener: (swap: Swap | ReverseSwap, reason: string) => void): this;
  emit(event: 'swap.failed', swap: Swap | ReverseSwap, reason: string): boolean;
}

class Service extends EventEmitter {
  public allowReverseSwaps = true;

  public swapRepository: SwapRepository;
  public reverseSwapRepository: ReverseSwapRepository;

  private pairRepository: PairRepository;

  private feeProvider: FeeProvider;
  private rateProvider: RateProvider;

  private pairs = new Map<string, PairType>();

  constructor(
    private logger: Logger,
    private boltz: BoltzClient,
    rateInterval: number,
    currencies: CurrencyConfig[]) {

    super();

    this.pairRepository = new PairRepository();
    this.swapRepository = new SwapRepository();
    this.reverseSwapRepository = new ReverseSwapRepository();

    this.feeProvider = new FeeProvider(this.logger, this.boltz);
    this.rateProvider = new RateProvider(this.logger, this.feeProvider, rateInterval, currencies);
  }

  public init = async (pairs: PairConfig[]) => {
    // Update the pairs in the database with the ones in the config
    let dbPairs = await this.pairRepository.getPairs();

    type PairArray = PairConfig[] | Pair[];

    const isUndefinedOrNull = (value: any) => value === undefined || value === null;

    const comparePairArrays = (array: PairArray, compare: PairArray, callback: Function) => {
      array.forEach((pair: PairConfig | Pair) => {
        let inCompare = false;

        compare.forEach((comparePair: PairConfig | Pair) => {
          if (pair.base === comparePair.base &&
            pair.quote === comparePair.quote) {

            // If the rate is equal in config and database or not defined in the config
            // and null in the database the database entry doesn't have to be updated
            if (pair.rate === comparePair.rate ||
              (isUndefinedOrNull(pair.rate)) && isUndefinedOrNull(comparePair.rate)) {

              inCompare = true;
            }
          }
        });

        if (!inCompare) {
          callback(pair);
        }
      });
    };

    const promises: Promise<any>[] = [];

    comparePairArrays(dbPairs, pairs, (pair: {
      base: string,
      quote: string,
      rate?: number,
    }) => {
      promises.push(this.pairRepository.removePair(pair));
      this.logger.debug(`Removing pair from database: ${stringify(pair)}`);
    });

    comparePairArrays(pairs, dbPairs, (pair: {
      base: string,
      quote: string,
      rate?: number,
    }) => {
      promises.push(this.pairRepository.addPair(pair));
      this.logger.debug(`Adding pair to database: ${stringify(pair)}`);
    });

    await Promise.all(promises);

    if (promises.length !== 0) {
      dbPairs = await this.pairRepository.getPairs();
    }

    this.logger.verbose('Updated pairs in database with config');

    // Make sure all pairs are supported by the backend and init the pairs array
    const { chainsMap } = await this.boltz.getInfo();
    const chainMap = new Map<string, CurrencyInfo.AsObject>();

    chainsMap.forEach(([symbol, chain]) => {
      chainMap.set(symbol, chain);
    });

    const verifyBackendSupport = (symbol: string) => {
      if (!chainMap.get(symbol)) {
        throw Errors.CURRENCY_NOT_SUPPORTED_BY_BACKEND(symbol);
      }
    };

    this.feeProvider.init(pairs);
    await this.rateProvider.init(dbPairs);

    dbPairs.forEach((pair) => {
      try {
        verifyBackendSupport(pair.base);
        verifyBackendSupport(pair.quote);

        this.pairs.set(pair.id, {
          // The values have to be set manually to avoid "TypeError: Converting circular structure to JSON" errors
          id: pair.id,
          base: pair.base,
          quote: pair.quote,
        });
      } catch (error) {
        this.logger.warn(`Could not initialise pair ${pair.id}: ${error.message}`);
      }
    });

    this.logger.verbose(`Initialised ${this.pairs.size} pairs: ${stringify(Array.from(this.pairs.keys()))}`);

    this.listenAbort();
    this.listenClaims();
    this.listenRefunds();
    this.listenInvoices();
    this.listenTransactions();
  }

  /**
   * Gets all supported pairs and their conversion rates
   */
  public getPairs = () => {
    const warnings: ServiceWarning[] = [];

    if (!this.allowReverseSwaps) {
      warnings.push(ServiceWarning.ReverseSwapsDisabled);
    }

    return {
      warnings,
      pairs: mapToObject(this.rateProvider.pairs),
    };
  }

  /**
   * Gets the fee estimation for all supported currencies
   */
  public getFeeEstimation = async () => {
    const feeEstimation = await this.boltz.getFeeEstimation('', 2);

    return feeMapToObject(feeEstimation.feesMap);
  }

  /**
   * Gets a hex encoded transaction from a transaction hash on the specified network
   */
  public getTransaction = (currency: string, transactionHash: string) => {
    return this.boltz.getTransaction(currency, transactionHash);
  }

  /**
   * Broadcasts a hex encoded transaction on the specified network
   */
  public broadcastTransaction = async (currency: string, transactionHex: string) => {
    this.logger.silly(`Broadcasting ${currency} transaction: ${transactionHex}`);

    try {
      const response = await this.boltz.broadcastTransaction(currency, transactionHex);
      return response;
    } catch (error) {
      if (error.details === 'non-final (code 64)') {
        throw Errors.TRANSACTION_NOT_FINAL();
      } else {
        throw error;
      }
    }
  }

  /**
   * Creates a new Swap from the chain to Lightning
   */
  public createSwap = async (pairId: string, orderSide: string, invoice: string, refundPublicKey: string) => {
    await this.checkSwapInvoice(invoice);

    const { base, quote, rate } = this.getPair(pairId);

    const side = this.getOrderSide(orderSide);

    const chainCurrency = side === OrderSide.BUY ? quote : base;
    const lightningCurrency = side === OrderSide.BUY ? base : quote;

    const satoshi = getAmountOfInvoice(invoice);

    this.verifyAmount(satoshi, pairId, side, false, rate);
    const { baseFee, percentageFee } = await this.feeProvider.getFee(pairId, chainCurrency, satoshi, false);

    const {
      address,
      redeemScript,
      expectedAmount,
      timeoutBlockHeight,
    } = await this.boltz.createSwap(base, quote, side, rate, baseFee + percentageFee, invoice, refundPublicKey, OutputType.COMPATIBILITY);
    await this.boltz.listenOnAddress(chainCurrency, address);

    const id = generateId(6);

    await this.swapRepository.addSwap({
      id,
      invoice,
      pair: pairId,
      orderSide: side,
      fee: percentageFee,
      lockupAddress: address,
    });

    return {
      id,
      address,
      redeemScript,
      expectedAmount,
      timeoutBlockHeight,
      bip21: encodeBip21(
        chainCurrency,
        address,
        expectedAmount,
        `Submarine Swap to ${lightningCurrency}`,
      ),
    };
  }

  /**
   * Creates a new reverse Swap from Lightning to the chain
   */
  public createReverseSwap = async (pairId: string, orderSide: string, claimPublicKey: string, amount: number) => {
    if (!this.allowReverseSwaps) {
      throw Errors.REVERSE_SWAPS_DISABLED();
    }

    const { base, quote, rate } = this.getPair(pairId);

    const side = this.getOrderSide(orderSide);
    const chainCurrency = side === OrderSide.BUY ? base : quote;

    this.verifyAmount(amount, pairId, side, true, rate);
    const { baseFee, percentageFee } = await this.feeProvider.getFee(pairId, chainCurrency, amount, true);

    const {
      invoice,
      minerFee,
      amountSent,
      redeemScript,
      lockupAddress,
      lockupTransaction,
      lockupTransactionHash,
    } = await this.boltz.createReverseSwap(base, quote, side, rate, baseFee + percentageFee, claimPublicKey, amount);

    await this.boltz.listenOnAddress(chainCurrency, lockupAddress);

    const id = generateId(6);

    await this.reverseSwapRepository.addReverseSwap({
      id,
      invoice,
      minerFee,
      pair: pairId,
      orderSide: side,
      fee: percentageFee,
      onchainAmount: amountSent,
      transactionId: lockupTransactionHash,
    });

    return {
      id,
      invoice,
      redeemScript,
      lockupTransaction,
      lockupTransactionHash,
    };
  }

  /**
   * Makes sure that there is no swap with the same invoice already
   */
  private checkSwapInvoice = async (invoice: string) => {
    const swap = await this.swapRepository.getSwap({
      invoice: {
        [Op.eq]: invoice,
      },
    });

    if (swap !== null) {
      throw Errors.SWAP_WITH_INVOICE_EXISTS_ALREADY();
    }
  }

  /**
   * Gets the base and quote asset and the rate of a currency
   */
  private getPair = (pairId: string) => {
    const { base, quote } = splitPairId(pairId);

    const pair = this.pairs.get(pairId);
    const pairInfo = this.rateProvider.pairs.get(pairId);

    if (!pair || !pairInfo) {
      throw Errors.PAIR_NOT_SUPPORTED(pairId);
    }

    return {
      base,
      quote,
      rate: pairInfo.rate,
      limits: pairInfo.limits,
      fees: pairInfo.fees,
    };
  }

  /**
   * Verfies that the requested amount is neither above the maximal nor beneath the minimal
   */
  private verifyAmount = (amount: number, pairId: string, orderSide: OrderSide, isReverse: boolean, rate: number) => {
    if (
      (!isReverse && orderSide === OrderSide.SELL) ||
      (isReverse && orderSide === OrderSide.BUY)) {
      // tslint:disable-next-line:no-parameter-reassignment
      amount = amount * (1 / rate);
    }

    const { limits } = this.getPair(pairId);

    if (limits) {
      if (Math.floor(amount) > limits.maximal) throw Errors.EXCEED_MAXIMAL_AMOUNT(amount, limits.maximal);
      if (Math.ceil(amount) < limits.minimal) throw Errors.BENEATH_MINIMAL_AMOUNT(amount, limits.minimal);
    } else {
      throw Errors.CURRENCY_NOT_SUPPORTED_BY_BACKEND(pairId);
    }
  }

  /**
   * Gets the corresponding OrderSide enum of a string
   */
  private getOrderSide = (orderSide: string) => {
    switch (orderSide.toLowerCase()) {
      case 'buy': return OrderSide.BUY;
      case 'sell': return OrderSide.SELL;

      default: throw Errors.ORDER_SIDE_NOT_SUPPORTED(orderSide);
    }
  }

  private listenTransactions = () => {
    this.boltz.on('transaction.confirmed', async (outputAddress: string, transactionId: string, amountReceived: number) => {
      const swap = await this.swapRepository.getSwap({
        lockupAddress: {
          [Op.eq]: outputAddress,
        },
      });

      if (swap) {
        if (!swap.status) {
          await this.swapRepository.setLockupTransactionId(swap, transactionId, amountReceived);
          this.emit('swap.update', swap.id, { event: SwapUpdateEvent.TransactionConfirmed });
        }
      }

      const reverseSwap = await this.reverseSwapRepository.getReverseSwap({
        transactionId: {
          [Op.eq]: transactionId,
        },
      });

      if (reverseSwap) {
        if (!reverseSwap.status) {
          await this.updateSwapStatus<ReverseSwap>(
            reverseSwap,
            SwapUpdateEvent.TransactionConfirmed,
            this.reverseSwapRepository.setReverseSwapStatus,
          );
        }
      }
    });
  }

  private listenInvoices = () => {
    this.boltz.on('invoice.paid', async (invoice: string, routingFee: number) => {
      let swap = await this.swapRepository.getSwap({
        invoice: {
          [Op.eq]: invoice,
        },
      });

      if (swap) {
        swap = await this.swapRepository.setInvoicePaid(swap, routingFee);
        this.emit('swap.update', swap.id, { event: SwapUpdateEvent.InvoicePaid });
      }
    });

    this.boltz.on('invoice.failedToPay', async (invoice: string) => {
      const swap = await this.swapRepository.getSwap({
        invoice: {
          [Op.eq]: invoice,
        },
      });

      if (swap) {
        const error = Errors.INVOICE_COULD_NOT_BE_PAID();

        await this.updateSwapStatus<Swap>(swap, SwapUpdateEvent.InvoiceFailedToPay, this.swapRepository.setSwapStatus);

        this.logger.info(`Swap ${swap.id} failed: ${error.message}`);
        this.emit('swap.failed', swap, error.message);
      }
    });

    this.boltz.on('invoice.settled', async (invoice: string, preimage: string) => {
      let reverseSwap = await this.reverseSwapRepository.getReverseSwap({
        invoice: {
          [Op.eq]: invoice,
        },
      });

      if (reverseSwap) {
        reverseSwap = await this.reverseSwapRepository.setInvoiceSettled(reverseSwap, preimage);

        this.logger.verbose(`Reverse swap ${reverseSwap.id} succeeded`);

        this.emit('swap.update', reverseSwap.id, { preimage, event: SwapUpdateEvent.InvoiceSettled });
        this.emit('swap.successful', reverseSwap);
      }
    });
  }

  private listenClaims = () => {
    this.boltz.on('claim', async (lockupTransactionId: string, minerFee: number) => {
      const swap = await this.swapRepository.getSwap({
        lockupTransactionId: {
          [Op.eq]: lockupTransactionId,
        },
      });

      if (swap) {
        await this.swapRepository.setMinerFee(swap, minerFee);
        this.logger.verbose(`Swap ${swap.id} succeeded`);
        this.emit('swap.successful', swap);
      }
    });
  }

  private listenAbort = () => {
    this.boltz.on('abort', async (invoice: string) => {
      const swap = await this.swapRepository.getSwap({
        invoice: {
          [Op.eq]: invoice,
        },
      });

      if (swap) {
        await this.swapRepository.setSwapStatus(swap, SwapUpdateEvent.SwapExpired);

        const error = Errors.ONCHAIN_HTLC_TIMED_OUT();

        this.logger.info(`Swap ${swap.id} failed: ${error.message}`);

        this.emit('swap.update', swap.id, { event: SwapUpdateEvent.SwapExpired });
        this.emit('swap.failed', swap, error.message);
      }
    });
  }

  private listenRefunds = () => {
    this.boltz.on('refund', async (lockupTransactionId: string, minerFee: number) => {
      let reverseSwap = await this.reverseSwapRepository.getReverseSwap({
        transactionId: {
          [Op.eq]: lockupTransactionId,
        },
      });

      if (reverseSwap) {
        reverseSwap = await this.reverseSwapRepository.setTransactionRefunded(reverseSwap, minerFee);

        const error = Errors.ONCHAIN_HTLC_TIMED_OUT();

        this.logger.info(`Reverse swap ${reverseSwap.id} failed: ${error.message}`);

        this.emit('swap.update', reverseSwap.id, { event: SwapUpdateEvent.TransactionRefunded });
        this.emit('swap.failed', reverseSwap, error.message);
      }
    });
  }

  private updateSwapStatus = async <T>(instance: T | null, event: SwapUpdateEvent, databaseUpdate: (instance: T, status: string) => Promise<T>) => {
    if (instance) {
      await databaseUpdate(instance, event);
      this.emit('swap.update', instance['id'], { event });
    }
  }
}

export default Service;
export { PairConfig };
